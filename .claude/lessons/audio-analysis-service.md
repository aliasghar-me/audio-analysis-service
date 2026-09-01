# Traps in this repository

## `.gitignore` patterns without a leading slash match at every depth

`storage/` was meant for the uploaded-audio directory at the repo root. It also
matched `apps/api/src/storage/`, so the module doing all the hashing and
content-addressed storage was never committed and a fresh clone could not build.

Nothing local catches this: typecheck, lint, the whole test suite and
`docker compose build` all read the working tree. `.dockerignore` was unaffected
because its patterns are context-root relative — which is exactly why the Docker
build kept passing and hid the problem.

**Always clone the repository into a temp directory and run the documented
quickstart before calling a repo done.** `git status --short --ignored` and
`git check-ignore -v <path>` are the fast checks.

## busboy limits do not all fail the same way

`fileSize` fails cleanly: it ends the stream and sets `part.file.truncated`.
`files` and `parts` do not — if one trips while an earlier file stream is still
open, busboy stops parsing, that stream never emits `end`, the handler never
returns, and the request **hangs with no response at all**.

So: no `files` cap. "One file per request" is enforced in the route by iterating
`request.parts()`. `parts: 10` is kept deliberately — removing it moves the hang
to the `fields` limit (measured, not assumed). Any test touching multipart limits
should race the inject against a timeout and assert it responded at all.

## Fastify framework errors already carry the right status

`FST_ERR_CTP_INVALID_MEDIA_TYPE` arrives with `statusCode: 415`. An error handler
that maps everything unrecognised to 500 turns malformed client requests into
fake server faults. Preserve `error.statusCode` when it is a 4xx.

## `next build` rewrites `next-env.d.ts` with double quotes

Prettier reformats it, Next puts it back, `format:check` fails after every build.
The file says "should not be edited" — it is in `.prettierignore`.

## Prisma

- `@map` every field or Postgres columns come out camelCase and need quoting
  forever, while `@@map` makes the table snake_case — an inconsistency a reviewer
  meets the first time they open psql.
- A schema change needs `prisma generate` before tests. `test:integration` does
  not run it; `typecheck` does, so `pnpm verify` self-heals and the standalone
  script does not.
- `prisma migrate reset` requires explicit user consent via
  `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`.
- A real VBR file reports a **fractional** average bitrate; the column is an
  integer. Round explicitly rather than letting the driver truncate.

## Docker compose

`migrate` is its own service built from the same Dockerfile. `docker compose
build api web` does **not** rebuild it, so a schema change appears to have no
effect. Use `docker compose build` with no arguments.

## The automation browser has no working media pipeline

`<audio>` never reaches `loadedmetadata` there — even a 44-byte silent WAV
data-URI times out — so `0:00 / 0:00` is not an app bug. Check with a known-good
data-URI control before investigating the server.

## Chasing 100% coverage finds dead code, not just missing tests

Every gap that could not be covered turned out to be code that should not have
existed: a method nothing called, a `src/` export only tests used, and two
`.catch()` swallows that made the caller's own error handling unreachable. When
a branch is hard to reach, ask whether it should exist before reaching for a
mock — and never add an injectable seam purely to satisfy a coverage number.

`music-metadata`'s `parseBuffer` never throws for malformed input; it resolves
with an empty format. Any `catch` around it is unreachable. The container check
in `toFacts` is what rejects a WAV or a PDF.

Vitest 4: coverage across several suites has to come from one run with
`projects`, not several runs — there is no merge step here.

## CI needs TWO Postgres services

`test/setup.ts` refuses to run when `TEST_DATABASE_URL` equals `DATABASE_URL`,
which is a guard worth keeping. A CI job with a single service trips it and
fails on the first build.

## `pnpm audit` flags Prisma's transitive drivers

`@prisma/client -> prisma` pulls `mysql2` and `deepmerge-ts`. Neither is
reachable from a Postgres-only service, but `pnpm.overrides` pins them to
patched versions, which is cheaper than re-explaining the advisory every time.
