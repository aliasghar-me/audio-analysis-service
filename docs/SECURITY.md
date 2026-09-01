# Security

The threat surface of an endpoint that accepts arbitrary files from anyone, and
what is done about it. Summarised in the [README](../README.md#testing).

## The suite

`test/security/` is a separate gate covering the threat surface an endpoint that
accepts arbitrary files actually has:

| File                        | Covers                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-type.spec.ts`         | twelve real containers renamed `.mp3` — WAV, FLAC, Ogg, MP4, AAC ADTS (both sync variants), JPEG, PNG, PDF, ELF, WebM, random binary — all rejected on content                                                                                                                            |
| `path-traversal.spec.ts`    | posix, deep, Windows, absolute and nested paths reduced to a basename; unicode, emoji and 400-character names; SQL, shell and HTML metacharacters stored literally                                                                                                                        |
| `storage-isolation.spec.ts` | an upload can never be stored as `.js`, `.php`, `.sh`, `.html`, `.env` or a config file; writes stay in a hash-shaped tree inside the root; a symlink planted at the destination is replaced rather than written through; archives are never unpacked; a filename cannot forge a log line |
| `error-disclosure.spec.ts`  | no stack traces, filesystem paths, credentials or internal field names in any response                                                                                                                                                                                                    |

Size limits, the duplicate race and the multipart hangs are covered in
`test/integration/` (`multipart.spec.ts`, `duplicate.spec.ts`, `failures.spec.ts`)
because they are correctness tests that happen to have security consequences.

There is no shell in this service at all — MP3 headers are parsed in-process
rather than by spawning `ffprobe` — so the entire command-injection class is
absent by construction rather than defended against. That is worth more than any
test of it.

`pnpm audit --prod --audit-level high` runs in CI and is clean. Two HIGH
advisories arrived transitively through `@prisma/client` (`mysql2`, reachable
only if you speak MySQL, which this service does not, and `deepmerge-ts`, used
by the Prisma CLI's config loader). Both are pinned to patched versions via
`pnpm.overrides` rather than carried with an explanation.

**What this does and does not claim.** 100% executable-code and branch coverage,
plus explicit tests for the identified threat surface. It does not claim the
service is secure — no rate limiting, no authentication (deliberate: the brief
has no users), and no penetration testing.
