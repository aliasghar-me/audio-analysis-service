# Testing

How this service is tested, and why each layer exists. The short version — the
commands and the headline numbers — is in the [README](../README.md#testing).

## The four suites

**426 tests across four suites.** `pnpm verify` runs the first three — 421 tests
with the coverage gate — and is what CI runs on every push. `test:large` is a
parallel CI job rather than part of `verify`, so the fast feedback loop stays at
about six seconds; `test:mutation` runs weekly and on demand.

**Unit** — colocated `*.spec.ts` next to their source. Pure functions, plus the
storage/database consistency contract against a real filesystem and a repository
that fails on demand. No database, so it runs on a bare checkout.

**Integration** — a real Fastify app against real Postgres and a real filesystem
through `app.inject()`. Nothing is mocked, because a mocked unique constraint
would prove nothing about the concurrency behaviour it exists to check.

**Security** — its own suite (`test/security/`) so a regression there is legible
in the CI job list rather than buried in a combined run. See below.

**Large** — the 50 MB ceiling at its real size. Every other size test runs at a
reduced `MAX_UPLOAD_BYTES` to keep the fast suite fast, which left the two
claims this README actually makes untested: that a 50 MB file is accepted, and
that the service does not hold one in memory. Its own script and its own CI job.

## Coverage: 100%, enforced

```text
Statements   100%     Branches   100%
Functions    100%     Lines      100%
```

Thresholds live in `apps/api/vitest.config.ts` and fail the build when coverage
drops — including in CI. Branches are the number that matters: a file sits at
100% lines while an `else` has never once executed.

Coverage is measured across all three suites **in a single run**, because
measuring them separately would give three incomplete pictures and no way to
merge them — the unit suite never touches `routes.ts`, and the integration suite
never reaches the failure branches that need a stubbed repository.

Two things are excluded, both deliberately and both stated here rather than
buried in a config:

| Excluded           | Why                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/generated/**` | Written by `prisma generate`. Not ours, not reviewed, rewritten on every schema change.                                                                                                                                                                                               |
| `src/main.ts`      | The process entry point: loads env, opens the pool, binds a port, installs signal handlers. Covering it in-process would mean calling `listen()` and `process.exit()` inside the test runner. Everything it composes — `buildApp`, `loadEnv`, `createDatabase` — is covered directly. |

Reaching 100% was not a matter of adding assertions until a number moved. It
found three pieces of code that should not have existed: an `ingest()` method
nothing called, a `readAudioFactsFromBuffer` in `src/` that only tests used (and
which carried a `catch` nothing could reach, because `parseBuffer` resolves with
an empty format for malformed input rather than throwing), and two redundant
`.catch()` swallows in `FileStore` that made the caller's own error handling
unreachable. Deleting those was the fix; the coverage was a side effect.

## Mutation testing: 92.2%

Coverage says every branch executed. It does not say a test would fail if `>`
became `>=`, and this service's scoring thresholds and range arithmetic are
exactly where an off-by-one hides behind a green suite.

`pnpm test:mutation` runs Stryker over the pure modules — `audio/`,
`http/range.ts`, `http/errors.ts`, `uploads/presenter.ts`. Anything touching
Postgres or the filesystem is excluded: every mutant re-runs the suite, and
those mutants mostly prove the database still works.

It started at **82.0%** and found something coverage could not. `presenter.ts`
scored **15%**: replacing its entire return value with `{}` survived, because it
had only ever been checked indirectly by integration tests asserting fields on a
response. Nothing tested the mapping itself — including that it drops
`storagePath`. It now has its own spec and scores 100%.

The other lesson was about assertion level. Every bitrate-tier mutant survived
(`>= 320` → `> 320`) because the tests asserted the final 1–10 score, and
rounding absorbs a 0.5-point shift in one component. The tests now assert the
`breakdown` component at each boundary, which is where the thresholds live.

|                | start | now       |
| -------------- | ----- | --------- |
| overall        | 82.0% | **92.2%** |
| `presenter.ts` | 15.4% | 100%      |
| `sniff.ts`     | 71.4% | 95.9%     |
| `quality.ts`   | 79.8% | 92.1%     |
| `duration.ts`  | 100%  | 100%      |

The gate breaks below 90%. The ~33 remaining survivors were read individually
and are predominantly **equivalent mutants** — removing the comma guard in
`range.ts`, for example, still returns `none`, because the anchored pattern
rejects a multi-range header anyway. Killing those would mean contorting tests
around code paths that cannot behave differently, which makes a suite worse.
Mutation runs weekly and on demand rather than on every push; a slow gate on
every commit is the over-engineering this project is trying to avoid.

## Three kinds of fixture, on purpose

**Synthetic MPEG-1 frames.** There is no MP3 encoder on the development machine (no ffmpeg, lame or sox), so `test/helpers/synthesize-mp3.ts` emits **valid Layer III CBR frames** in TypeScript: a 4-byte header (sync, version, layer, bitrate index, sample-rate index, channel mode) followed by a zeroed payload of `floor(144 × bitrate ÷ sampleRate)` bytes, optionally behind a syncsafe ID3v2 tag. This works because no metadata parser decodes audio to read a header — it walks the chain of frame headers — so bitrate, sample rate, channels and duration all come out exactly as constructed, and `music-metadata` reads them with millisecond-accurate duration. Being able to dial any bitrate, sample rate, channel count and length on demand is what makes the scoring and outlier assertions cheap and exact, and the generator is itself unit-tested against known-good byte sequences (`FF FB 90 00` for 128 kbps/44.1 kHz/stereo, frame size 417).

**Synthetic MPEG-2 and MPEG-2.5 frames.** The same generator takes an MPEG version, which is how the low sample rates are reached — 22.05, 16, 11.025 and 8 kHz files go through the real pipeline, and with them the two lowest sample-rate scoring tiers, which had previously only ever been fed numbers directly. It is worth its own paragraph because the version field changes three things at once: the sample-rate table, the bitrate table, and whether a frame codes 1152 samples or 576. Get one right and the other two wrong and the file still parses, with a plausible but wrong duration. Header byte 1 is `0xFB`, `0xF3` and `0xE3` for MPEG-1, 2 and 2.5, and the frame-size coefficient drops from 144 to 72 below MPEG-1. All of that is asserted byte-for-byte, because a bug in the generator would quietly invalidate everything built on it.

**One real file.** Synthetic frames can only ever test the assumptions that built them, so `test/fixtures/david-graeber-voice-cc0.mp3` is a genuine LAME 3.99r encode — 18.5 s of speech, 48 kHz mono, VBR, with a real ID3v2.3 tag — from Wikimedia Commons under **CC0**, which is what makes it redistributable inside this repository with no obligations attached. Full provenance, SHA-256 and refresh instructions are in `test/fixtures/README.md`, and the suite asserts that hash so a swapped or corrupted fixture fails loudly instead of quietly changing what every other assertion means.

It earned its place immediately. A real VBR file reports a **fractional** average bitrate — 96227.979… bps — where every synthetic CBR fixture reports a clean integer. `bitrate_bps` is an integer column, so the service had been relying on the database driver to truncate that silently. It now rounds explicitly, with a test that says so. The same file is also the only thing covering the `V2`-style LAME preset branch of the CBR/VBR detection, since `music-metadata` reports the preset name rather than the literal string `VBR`.

Still not covered: ID3 embedded cover art, and a Xing header on a stripped file (the tier-three duration fallback is exercised only by unit tests). A broader corpus of real encodes is on the list below.

---
