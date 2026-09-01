# Audio Analysis Service

Upload an MP3, get back its duration, an encoding-quality score out of 10, and whether those exact bytes have been uploaded before. A small Fastify + PostgreSQL service with a one-screen Next.js UI.

```bash
curl -F "file=@song.mp3" http://localhost:4490/api/upload
```

```json
{
  "duplicate": false,
  "originalUploadId": null,
  "upload": { "id": "01a05da6…", "filename": "song.mp3", "contentHash": "15605ad2…", "sizeBytes": 7680000 },
  "analysis": {
    "duration": { "seconds": 192, "formatted": "03:12", "isOutlier": false,
                   "outlierPolicy": { "minSeconds": 5, "maxSeconds": 600 } },
    "quality": { "score": 10, "max": 10, "basis": "encoding", "breakdown": { "bitrate": 4, "sampleRate": 3, … } },
    "format": { "codec": "MPEG 1 Layer 3", "bitrateBps": 320000, "sampleRateHz": 48000, "channels": 2 }
  }
}
```

---

## Scope

The brief is small and says twice that it values simplicity over
over-engineering, so it is worth being explicit about what is here and why.

**What the brief asked for**

| Requirement                                    | Where                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/upload`, multipart, accepts `.mp3`  | `uploads/routes.ts`                                                                  |
| Store the file                                 | `storage/store.ts` — content-addressed by SHA-256                                    |
| Return analysis                                | `uploads/presenter.ts`                                                               |
| Duration + outlier flag                        | `audio/duration.ts`, rule documented under [Assumptions](#the-duration-outlier-rule) |
| Quality score 1–10 from simple heuristics      | `audio/quality.ts`, table under [Assumptions](#the-quality-score)                    |
| Exact duplicate detection, filename irrelevant | SHA-256 + `@unique` on `content_hash`                                                |
| Reference to the original upload               | `originalUploadId` in the response                                                   |
| A unit test and an integration test            | `audio/*.spec.ts`, `test/integration/duplicate.spec.ts`                              |
| Production-grade database                      | PostgreSQL, with the constraint doing real work                                      |

A duplicate creates **no second row and no second file** — the original's
`duplicateCount` is incremented instead. That is the reading of "optimized use
of storage and databases" the brief asks for.

**Also here, and why**

- **`GET` endpoints** — the UI needs them, and they prove the storage layer is real rather than write-only.
- **A one-page web UI** — the role is titled Full Stack Developer.
- **`Range` support on the audio endpoint** — found by driving the UI in a real browser: without it an `<audio>` element cannot seek, and every scrub refetches the whole file.
- **A security suite** — this endpoint takes arbitrary bytes from anyone, so fake `.mp3`s, path traversal and storage isolation get their own tests.
- **Coverage and mutation gates** — cheap to run, and between them they found dead code, a presenter that no test actually checked, and boundary assertions that could not fail.

**Deliberately not here**

Auth, rate limiting, queues, Redis, S3, Kubernetes, virus scanning, and any DSP
or ML audio analysis. Each is argued in [What is deliberately not here](#what-is-deliberately-not-here)
and [With more time](#with-more-time).

---

## Running it

### Everything at once

```bash
docker compose up
```

- UI — <http://localhost:3490>
- API — <http://localhost:4490>

Migrations run automatically in a one-shot `migrate` container before the API starts, so a clean checkout on a fresh volume comes up working.

### Local development

```bash
cp .env.example .env
pnpm install
pnpm infra:up          # Postgres on 5495, a tmpfs test Postgres on 5496
pnpm db:migrate        # apply migrations to the dev database
pnpm dev               # API on 4490, UI on 3490
```

Then `pnpm verify` — typecheck, lint, format check, and the unit, security and integration suites with the 100% coverage gate — is the single "is this repo healthy" command. `.github/workflows/ci.yml` runs exactly that on every push and pull request, against two Postgres service containers (two, not one: `test/setup.ts` refuses to run when `TEST_DATABASE_URL` equals `DATABASE_URL`), alongside a parallel job for the 50 MB suite and a production dependency audit. Mutation testing runs weekly and on demand.

Requires Node ≥ 22 (developed on 26.7) and pnpm 9.15.9. **No ffmpeg, no native modules, no system audio libraries.**

Ports are in the x495 block rather than the defaults so this can run alongside other local services without a collision.

---

## Architecture

```
Browser ──► Next.js (3490) ──rewrite──► Fastify (4490) ──► PostgreSQL   (metadata + the unique constraint)
                                                      └──► Local disk  (content-addressed audio)
```

```
POST /api/upload
   │
   ├─ 1. stream the body to a temp file, hashing (SHA-256) and capturing the
   │     first 16 bytes in the SAME pass
   ├─ 2. truncated at the size limit?  ─────────────────────► 413
   ├─ 3. zero bytes?                   ─────────────────────► 400 EMPTY_FILE
   ├─ 4. magic bytes say MP3?          ─────────────────────► 400 INVALID_AUDIO
   ├─ 5. hash already in the database? ─────────────────────► 200 duplicate
   │        (no parse, no second copy of the bytes — the cheapest path)
   ├─ 6. parse headers with music-metadata ─────────────────► 400 INVALID_AUDIO
   ├─ 7. score quality + flag duration outlier (pure functions)
   ├─ 8. rename temp file to storage/audio/<aa>/<bb>/<sha256>.mp3  (atomic)
   └─ 9. insert the row ────────────────────────────────────► 201
            └─ unique violation (a concurrent identical upload) ──► 200 duplicate
```

### Layout

<details>
<summary>Full file layout</summary>

```
apps/api/src/
├── app.ts                 buildApp(deps) — the seam the integration tests use
├── main.ts                process entry: env, database, listen, graceful shutdown
├── config/env.ts          Zod-validated env; the only place process.env is read
├── db/client.ts           Prisma client factory (driver adapter)
├── http/                  error codes → HTTP statuses, and one error handler
├── audio/                 sniff, metadata, quality, duration — pure, no I/O
├── storage/store.ts       the only file in the service that touches `fs`
└── uploads/               routes → service → repository, plus the presenter
apps/web/src/              one page, one client component, one fetch wrapper
```

</details>

The layering rule, in one line: **routes do HTTP, the service owns the order of operations, the repository owns every Prisma call, and `audio/` is pure.** That last part is why the unit suite needs no database and runs in under 200 ms.

### Why these boundaries

- `audio/*` are pure functions taking plain objects. The scoring table is testable across its whole grid without a file, a socket or a mock.
- `storage/store.ts` is the only importer of `node:fs`. Moving to S3 is one file's blast radius — which is the actual argument for the boundary, not the abstraction itself.
- `presenter.ts` is the only place a database row becomes JSON, so `storagePath` cannot leak by accident and the duplicate response is provably the same shape as the original (same function builds both).

---

## API

Every error uses one envelope:

```json
{ "error": { "code": "INVALID_AUDIO", "message": "…", "details": { "reason": "magic_bytes" } } }
```

`code` is a stable enum to branch on; `message` is for humans. A single table in `src/http/errors.ts` maps code → status, so the two cannot drift apart.

| Endpoint                          | Purpose                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/upload`                | multipart, field name **`file`**. `201` new, `200` duplicate.                            |
| `GET /api/uploads?limit=&cursor=` | newest first, keyset pagination.                                                         |
| `GET /api/uploads/:id`            | one upload with its stored analysis.                                                     |
| `GET /api/uploads/:id/file`       | the stored bytes. Honours `Range` (206) so players can seek; `ETag` is the content hash. |
| `GET /health`                     | `{ status, database }`; 503 when the database is unreachable.                            |

| Code                     | Status | When                                                                                      |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | the request was not `multipart/form-data`                                                 |
| `NO_FILE`                | 400    | no file part, or it arrived under the wrong field name                                    |
| `TOO_MANY_FILES`         | 400    | more than one file part; one upload per request                                           |
| `EMPTY_FILE`             | 400    | zero bytes                                                                                |
| `INVALID_AUDIO`          | 400    | `details.reason`: `magic_bytes`, `parse_failed`, `not_mpeg`, `not_layer_3`, `no_duration` |
| `FILE_TOO_LARGE`         | 413    | over `MAX_UPLOAD_BYTES`; `details.maxBytes` says by what standard                         |
| `TOO_MANY_PARTS`         | 413    | more multipart parts or fields than we will parse                                         |
| `VALIDATION_ERROR`       | 400    | bad route param or query string                                                           |
| `UPLOAD_NOT_FOUND`       | 404    | unknown id                                                                                |
| `ROUTE_NOT_FOUND`        | 404    | no such route — distinct from an unknown upload id                                        |
| `FILE_GONE`              | 410    | the row exists, the bytes do not                                                          |
| `RANGE_NOT_SATISFIABLE`  | 416    | a `Range` past the end of the file; the reply carries `Content-Range: bytes */<size>`     |
| `INTERNAL_ERROR`         | 500    | a bug; the real error goes to the log only                                                |

`docs/api.http` has ready-to-run requests for every one of these.

**One file per request.** The file must arrive in a form field named `file`, and a second file part is refused with `TOO_MANY_FILES` rather than silently ignored. This is enforced in the route rather than through `@fastify/multipart`'s `limits.files`, and that is not a stylistic preference: busboy trips a `files` cap _while the first file's stream is still open_, then stops parsing, so the stream never ends, the handler never returns, and the request hangs with no response at all. `fileSize` is the one limit that fails cleanly — it ends the stream and sets `truncated`. There are tests asserting the request answers rather than hangs.

---

## Design decisions

### Duplicate detection: SHA-256 over the raw bytes

The filename, the upload time and the declared MIME type are all irrelevant _by construction_ rather than by a rule someone has to remember. The storage path is derived from the hash, so identical files cannot occupy two slots even if the database were wrong.

**The unique constraint on `content_hash` is the authority, not the lookup.** The service does check for an existing row first, but that is a fast path two concurrent requests can both miss. When they do, Postgres rejects the loser with `P2002`, the service re-reads the winning row, and both requests return the same duplicate response. There is a test that fires five identical uploads at once and asserts exactly one row, one file, and one id across all five responses.

A duplicate returns the **stored** analysis and never re-parses or re-stores. That is the whole reason hashing comes before parsing.

### `music-metadata`, not `ffprobe`

`ffprobe` is more authoritative and would give exact frame counts for exotic VBR files. It is also a native binary the reviewer has to install, it means shelling out to a subprocess, and it turns `pnpm install` into an OS-specific setup step. `music-metadata` is pure JavaScript, reads the same MPEG frame headers, and supplies every field the score needs.

The accepted cost: no frame-accurate duration for a VBR file with a stripped Xing header. `audio/metadata.ts` therefore resolves duration in three documented tiers — the parser's own value, then sample count ÷ sample rate, then a CBR estimate from payload size and bitrate — and returns `400 INVALID_AUDIO` only if all three fail.

### Content decides, never the filename

`part.filename` and `part.mimetype` are strings the client wrote. `curl -F "file=@virus.exe;filename=song.mp3;type=audio/mpeg"` satisfies both. They are recorded for audit and used for **nothing** else. Validation is two content checks: a cheap magic-byte gate (ID3 tag or a valid MPEG frame sync, with the reserved version and layer bit patterns rejected), then the parser itself.

The corollary, stated plainly because it cuts both ways: **a `.wav` is rejected because its bytes are not MPEG, not because of its name — and valid MP3 bytes sent as `resume.pdf` are accepted.** Both are covered by tests. This is the same principle the duplicate requirement asks for, applied consistently.

### Committing bytes before inserting the row

A deliberate choice between two failure modes:

- **File on disk, no row** — invisible to every endpoint, costs disk, and self-heals: the next upload of those bytes recreates the row and rewrites the identical file.
- **Row in database, no file** — a broken record served to clients.

The first is strictly better, so the write order produces it. If the insert fails for a reason other than a duplicate, the service re-checks whether a row now claims that hash before deleting anything — because a `P2002` loser must _not_ delete the file it just wrote; the winner's row addresses exactly those bytes.

### Streaming, not buffering

The upload is piped through a hash and a head-capture into a temp file in one pass. `part.toBuffer()` would be four lines shorter and would hold up to 50 MB per concurrent request in memory. The hash must be known before we can decide whether to keep the bytes, and hashing is inherently streaming, so there was nothing to gain. The temp file also lands on the same filesystem as the store, which is what makes the commit an atomic `rename`.

One subtlety worth flagging: when a stream hits `limits.fileSize`, busboy **ends it normally and sets `truncated`** rather than raising an error. Without an explicit check the service would cheerfully hash and store a prefix of a 200 MB file.

### PostgreSQL, not SQLite

The brief asks for a production-grade database, and the concurrency story above needs one: SQLite's single-writer lock turns concurrent uploads into `SQLITE_BUSY` retries rather than a clean constraint violation. `jsonb`, real `timestamptz` and connection pooling all start to matter the moment there is a second API process. SQLite would have been fine for a single-process demo and a worse answer to the question actually being asked.

### Local disk, not S3

Content-addressed at `storage/audio/<aa>/<bb>/<sha256>.mp3`, sharded two levels so no directory accumulates millions of entries. It does not survive multiple hosts. S3 with the same key scheme is a `FileStore` swap, because nothing outside `storage/store.ts` imports `node:fs`.

### `200` for a duplicate, not `201` or `409`

`201 Created` would assert a resource came into existence when nothing was written. `409 Conflict` would call a success a failure — this is the idempotent outcome the feature exists to produce, and the body carries the full analysis. `200` plus `duplicate: true` lets a client branch on the status line alone and still parse one schema.

The duplicate body is where the requirement is made visible: `upload.filename` is the name on record, `submittedFilename` is what this request called it, and `originalUploadId` points at the original. One response body demonstrates that filenames do not matter.

### Range requests on the audio endpoint

An audio player does not download a file and then seek — it seeks by asking for byte ranges. The file endpoint advertises `Accept-Ranges: bytes` and answers a `Range` with `206` plus a `Content-Range`, which is the difference between scrubbing a track costing 200 KB and costing the whole 50 MB every time the playhead moves. `createReadStream` seeks to the offset rather than reading and discarding, so serving the tail of a file costs the same as serving the head.

Only single ranges are honoured. Multi-range responses need `multipart/byteranges`, no audio player asks for them, and a server is explicitly allowed to ignore a `Range` it does not wish to satisfy and return `200` — so that is what a multi-range or unknown-unit request gets. A range genuinely past the end of the file gets a `416` carrying `Content-Range: bytes */<size>`, so the client can work out what it should have asked for. The parsing is a pure function in `http/range.ts` with the tricky cases pinned by unit tests — notably that `bytes=-500` means the _last_ 500 bytes, which is the classic place to get this wrong.

### What is deliberately _not_ here

- **No `upload_events` audit table.** No endpoint would read it, it duplicates the structured request log, and it would make every ingest a two-statement transaction. `duplicateCount` and `lastUploadedAt` give the practical signal for two columns.
- **No index on `isOutlier` or `qualityScore`.** Two distinct values on a boolean; Postgres would ignore it. The only index besides the unique hash is `(createdAt DESC, id DESC)`, which is exactly the list endpoint's `ORDER BY`.
- **No shared types package.** `apps/web/src/lib/api.ts` hand-mirrors about 30 lines of interfaces. A third workspace with a build step to remove that duplication is not a trade worth making at this size — but it _is_ duplication, and it is the first thing that would break silently if the API response changed.
- **No Redis, queue, S3, auth, DI container, or `packages/` split.** No `DELETE` endpoint either: with no auth, anyone could destroy anyone's data, and deleting content-addressed bytes needs reference counting — the half-version is worse than none.
- **Fastify rather than NestJS**, which is what the rest of this codebase uses. One upload endpoint does not justify DI, decorators, modules and an SWC test transform.

---

## Trade-offs

Every row is a deliberate choice with a cost. The reasoning behind each is in **Design decisions** above; this table is the short version, including what was given up.

| Choice                                          | What it buys                                                                        | What it costs                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `music-metadata` over `ffprobe`                 | No native dependency; `pnpm install` is the whole setup, and the tests run anywhere | Less authoritative than ffprobe for exotic VBR files with a stripped Xing header — mitigated by a documented three-tier duration fallback |
| Exact-byte hashing over acoustic fingerprinting | Duplicate detection is exact, cheap, and provably filename-independent              | A re-encode of the same recording is correctly _not_ a duplicate; catching that needs Chromaprint and is a different problem              |
| Postgres over SQLite                            | A real unique constraint under concurrency, `jsonb`, `timestamptz`, pooling         | A running database is required even for the integration tests; SQLite would have been simpler for a single-process demo                   |
| Local disk over S3                              | Content-addressed layout, atomic same-filesystem `rename`, dedupe for free          | Does not survive more than one host. The swap is one file, because nothing outside `storage/store.ts` imports `node:fs`                   |
| Streaming to a temp file over `toBuffer()`      | Bounded memory regardless of concurrency; the commit is an atomic rename            | ~15 lines instead of 4, and a staging directory to keep clean                                                                             |
| Synchronous analysis over a queue               | One request, one answer, no job state to model or poll                              | A 50 MB upload holds a connection for the length of the parse                                                                             |
| Fastify over the house NestJS                   | No DI, decorators, modules or SWC test transform for one endpoint                   | Diverges from the other services in this codebase                                                                                         |
| Analysis frozen at ingest                       | A duplicate returns byte-identical results years later                              | Changing the scoring table does not retroactively rescore old rows; that would need a backfill                                            |
| Hand-mirrored API types in the web app          | No third workspace, no build step, no shared-package indirection                    | ~30 lines of duplication that would break silently if the response shape changed                                                          |
| No `DELETE` endpoint                            | No unauthenticated destruction of other people's data                               | Uploads cannot be removed through the API; deleting content-addressed bytes needs reference counting first                                |

## Assumptions

- **MP3 only**, ≤ 50 MB (`MAX_UPLOAD_BYTES`).
- **"Duplicate" means byte-identical.** A re-encode of the same song at a different bitrate is correctly _not_ a duplicate. Catching those needs acoustic fingerprinting, which is a different problem.
- **The outlier window is 5 s to 600 s** — see below.
- **Single API instance, local disk.** Two instances would each hold their own storage directory.
- **No users and no auth**, because the brief has none. Every upload is public.
- **Filenames are display metadata.** They never reach a filesystem path and never affect a decision.

### The duration outlier rule

> A file is an outlier when it is shorter than 5 seconds or longer than 10 minutes. Both bounds are configurable (`OUTLIER_MIN_SECONDS`, `OUTLIER_MAX_SECONDS`) and the active policy is echoed in every response.

Fixed thresholds rather than a statistical rule, and the reasoning matters more than the numbers. A z-score or IQR test over the `uploads` table is the textbook answer and is wrong here for three concrete reasons:

1. It is undefined until the table holds a meaningful sample — with one row, either everything is an outlier or nothing is.
2. It makes the flag **retroactive**. The same bytes uploaded a month apart would get different answers, which directly contradicts the duplicate requirement that identical bytes return the identical stored analysis. You would be forced to choose between a backfill job and a stored-vs-computed inconsistency.
3. It makes the tests non-deterministic: the assertion for one file would depend on which other files the suite happened to insert first.

The fixed window is also defensible on its own terms: this is a service for music and podcast segments, where under 5 s is a clip, a ringtone or a failed upload, and over 10 minutes is a DJ set, a lecture or a whole-album rip — legitimate files, but not what the rest of the pipeline is tuned for. It is one comparison, it is stateless, and moving it is an environment variable rather than a migration.

**The upgrade path**, once there is a real corpus: compute percentiles (flag below P1 / above P99 over a rolling 30-day window) nightly into a small stats table, and stamp the verdict onto the row at ingest so it stays immutable.

### The quality score

`scoreQuality()` is a pure function summing five components to a maximum of 10, then clamping to 1–10. The full breakdown is returned in the response _and stored on the row_, so a score is explainable years later even if the table changes.

| Signal               | Max | Scale                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bitrate**          | 4   | 320k → 4 · 256k → 3.5 · 192k → 3 · 160k → 2.5 · 128k → 2 · 96k → 1.25 · 64k → 0.75 · below → 0.25 | For a fixed codec, the bit budget is the best available proxy for how much of the signal survived. Weighted heaviest for that reason.                                                                                                                                                                                                                             |
| **Sample rate**      | 3   | ≥48k → 3 · ≥44.1k → 2.5 · ≥32k → 1.5 · ≥22.05k → 1 · below → 0.5                                  | Caps reproducible bandwidth outright (Nyquist). 44.1 kHz is the CD baseline.                                                                                                                                                                                                                                                                                      |
| **Channels**         | 1   | stereo → 1 · mono → 0.5                                                                           | Mono is correct for speech, so the weight is deliberately small.                                                                                                                                                                                                                                                                                                  |
| **Encoding mode**    | 1   | VBR → 1 · CBR → 0.75 · unknown → 0.5                                                              | At equal average bitrate VBR spends bits where they are needed. A small effect next to bitrate itself.                                                                                                                                                                                                                                                            |
| **Size consistency** | 1   | ratio 0.85–1.35 → 1 · 0.6–1.8 → 0.5 · outside → 0                                                 | The only component that looks at the _file_ rather than the _header_, and so the only one that can catch a lie: truncated, padded, or mis-declared files. The bands are deliberately asymmetric — ID3 tags and embedded cover art legitimately add bytes that carry no audio, so being larger than the bitrate implies is far less suspicious than being smaller. |

Unknown fields score neutral-low rather than zero — absence of evidence is not evidence of absence.

> **This measures encoding quality, not perceived quality.** A pristine 320 kbps encode of a clipped, hissy master scores 10. A 96 kbps encode of a flawless master scores 6. It cannot detect clipping, distortion, noise, a bad source, or a 96 kbps original re-encoded at 320. Perceived quality needs DSP (spectral rolloff, clipping detection, loudness and dynamic range) or a trained model — both out of scope by the brief, which asks for simple heuristics.

It is a transparent point table rather than a tuned formula on purpose: every number can be explained by pointing at a row.

---

## Testing

```bash
pnpm test:unit          # 301 tests, no database, ~1s
pnpm test:security      # 55 tests — the security gate, kept separate on purpose
pnpm test:integration   # 65 tests against real Postgres
pnpm test:coverage      # those three, with the 100% coverage gate
pnpm test:large         # 5 tests at real 50 MB sizes; its own CI job
pnpm test:mutation      # mutation testing over the pure modules
pnpm verify             # typecheck + lint + format + test:coverage
```

**426 tests across four suites**, with statements, branches, functions and lines
all at **100%** and a mutation score of **92.2%**. `pnpm verify` runs the first
three suites (421 tests) with the coverage gate and is what CI runs on every
push; the 50 MB suite is a parallel job and mutation testing runs weekly.

Nothing is mocked in the integration suite — a mocked unique constraint would
prove nothing about the concurrency behaviour it exists to check. There are no
skipped, `.only` or `.todo` tests.

Detail, and what each layer is actually for: **[docs/TESTING.md](docs/TESTING.md)**
and **[docs/SECURITY.md](docs/SECURITY.md)**. Runnable requests for every
endpoint and error: **[docs/api.http](docs/api.http)**.

---

## With more time

Roughly in order of value:

1. **A broader real-file corpus** — the one committed CC0 file covers VBR, a real encoder and a real ID3 tag, but not cover art or a stripped Xing header. MPEG-2/2.5 rates are now covered by synthesised fixtures, but not by real encodes. A small cached set of CC0 files across those axes is the remaining test gap.
2. **Async analysis behind a queue** — `POST` returns `202` with a `PENDING → READY` status. Matters as soon as parsing gets slower or files get bigger; today the analysis is fast enough that the synchronous path is the simpler correct answer.
3. **Object storage** behind the existing `FileStore` interface, which is the change that unblocks running more than one API instance.
4. **`storage:gc`** — reconcile the store against `SELECT content_hash` and delete orphans, closing the one failure mode this design deliberately accepts.
5. **Rate limiting** per IP, plus request-size accounting.
6. **Percentile-based outlier detection**, computed nightly and stamped at ingest so verdicts stay immutable.
7. **Acoustic fingerprinting** (Chromaprint) for near-duplicate detection — the same recording re-encoded, which exact hashing correctly misses.
8. **Real DSP** for perceived quality: clipping detection, spectral rolloff, LUFS.
9. **OpenAPI generated from the Zod schemas**, and a shared types package so the web client stops hand-mirroring the contract.
10. **Auth with per-user scoping**, which is also the precondition for a `DELETE` endpoint.
