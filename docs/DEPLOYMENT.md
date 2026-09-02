# Deployment

Deploys `audio-analysis-service` to a single VPS behind the Traefik instance
already running there.

```
                         Internet
                            │
                     audio-analysis.aliasghar.me
                            │
                          HTTPS :443
                            │
                     Traefik (host network, Let's Encrypt)
                            │
              ┌─────────────┴──────────────┐
        /api, /health                  everything else
              │                             │
         api :4490                      web :3490
              │                             │
      ┌───────┴────────┐            (Next.js, standalone)
      ▼                ▼
 postgres :5432   audio-storage volume
 (bridge only)     (MP3s, content-addressed)
```

Nothing in this stack publishes a host port. Traefik reaches the containers
over the bridge network; Postgres is reachable only from the other containers
on that network.

## Traefik, not Nginx

The obvious production recipe is Nginx plus Certbot, and it is the wrong one
**for this host**. This server already runs Traefik in host-network mode,
terminating `:80` and `:443` and holding the Let's Encrypt account for three
other applications (`adleak`, `evenit`, `dukkanify`). A second reverse proxy
would fail to bind those ports, and the version of that mistake that "works" —
stopping Traefik first — takes three live applications offline.

So this stack advertises itself to the existing proxy with router labels
instead. It is less code than an Nginx server block, and certificate issuance
and renewal are already solved on this box.

Two things Nginx would have needed explicit configuration for, and how they are
handled here:

| Concern              | Nginx                                                                                                                                   | Traefik                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 50 MB request bodies | `client_max_body_size` defaults to **1 MB** and must be raised, or every upload fails with a 413 that did not come from the application | No body limit by default; nothing to configure           |
| Upload timeouts      | `proxy_read_timeout` / `proxy_send_timeout`                                                                                             | Streams by default; no per-request cap on the entrypoint |

Traefik's `buffering` middleware is deliberately **not** used. Its
`maxRequestBodyBytes` looks like the right place to reject an oversized upload,
and enabling it spools the whole body to disk before forwarding — which defeats
the single-pass streaming hash the API is built around. The 50 MiB cap stays in
`@fastify/multipart`, which aborts mid-stream.

## One-time setup on the server

```bash
ssh <user>@168.231.79.73
install -d -m 0755 /opt/audio-analysis
```

Then, after the first `deploy.sh` run writes the template:

```bash
cd /opt/audio-analysis
openssl rand -hex 24          # POSTGRES_PASSWORD — hex, so it is URL-safe
vi .env.production            # set POSTGRES_PASSWORD and the same value in DATABASE_URL
chmod 600 .env.production
```

`.env.production` is the one file the deploy never overwrites, and it is
gitignored under both spellings.

## DNS

One A record, added at the registrar (Hostinger, for `aliasghar.me`):

| Type | Name             | Value           | TTL |
| ---- | ---------------- | --------------- | --- |
| `A`  | `audio-analysis` | `168.231.79.73` | 300 |

Verify it before deploying — Let's Encrypt's HTTP-01 challenge resolves the name
itself, and a certificate request against an unresolvable name fails and is
rate-limited:

```bash
dig +short audio-analysis.aliasghar.me    # must print 168.231.79.73
```

## Deploying

```bash
SSH_TARGET=<user>@168.231.79.73 ./deploy/deploy.sh
```

The script syncs the source tree, builds on the server, runs migrations as a
one-shot container, and waits for both health checks. It is idempotent: it never
touches `.env.production`, never removes a volume, and writes only inside
`/opt/audio-analysis`.

The source is built on the server rather than pulled from a registry. For one
small service with no CI configured that is the fewer-moving-parts choice; the
cost is that a deploy occupies the box for the length of a Docker build, which
would not be acceptable for anything under real traffic.

## Firewall

```bash
ufw status                    # inspect BEFORE changing anything
ufw allow OpenSSH             # first, always — before enabling
ufw allow 80,443/tcp
ufw enable
```

`ufw allow OpenSSH` goes first. Enabling `ufw` with a default-deny incoming
policy and no SSH rule ends the session and every future one.

No rule is needed to protect Postgres: it publishes no host port, so there is
nothing bound for the firewall to filter. The firewall is the second layer.

## Verifying a deploy

```bash
curl -fsS https://audio-analysis.aliasghar.me/health
curl -fsS -F file=@sample.mp3 https://audio-analysis.aliasghar.me/api/upload
```

## Persistence

`postgres-data` and `audio-storage` are named volumes. `docker compose down`
without `-v` leaves both in place, which is what makes a restart test
meaningful:

```bash
cd /opt/audio-analysis
docker compose --env-file .env.production -f deploy/compose.vps.yml down
docker compose --env-file .env.production -f deploy/compose.vps.yml up -d
# the previous upload is still there, and re-uploading it still reports duplicate
```

Never `down -v`. That deletes the database and every stored MP3.

## Rolling back

There are no image tags to roll back to — the server builds from whatever source
it was last given. To roll back, check out the earlier commit locally and run
`deploy.sh` again. A registry with SHA-tagged images would make this one line,
and is the first thing to add if this service outlives the assignment.

**A rollback does not undo a migration.** Migrations run forward before the new
code starts. The ones here are additive, so an older image against a newer
schema is safe; a destructive migration would need a deliberate down-migration.
