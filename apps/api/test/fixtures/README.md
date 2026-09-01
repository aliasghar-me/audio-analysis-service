# Test fixtures

## `david-graeber-voice-cc0.mp3`

A real, encoder-produced MP3, committed so the suite is not testing exclusively
against files this repository generated itself.

|                |                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**     | <https://commons.wikimedia.org/wiki/File:David_Graeber_-_voice_-_en.mp3>                                                                                                     |
| **Direct URL** | <https://upload.wikimedia.org/wikipedia/commons/1/16/David_Graeber_-_voice_-_en.mp3>                                                                                         |
| **Author**     | Vera de Kok ([User:1Veertje](https://commons.wikimedia.org/wiki/User:1Veertje)), own work                                                                                    |
| **Licence**    | **CC0 1.0** — Creative Commons Zero, public domain dedication (`{{self\|cc-zero}}` on the file page). No attribution required; the credit above is courtesy, not obligation. |
| **Retrieved**  | 2026-09-01                                                                                                                                                                   |
| **Size**       | 222,928 bytes                                                                                                                                                                |
| **SHA-256**    | `0680d1877d133441f6b8fdd1369e6d7d49c46a3925a3a23f1d0561db0d2bbd89`                                                                                                           |

CC0 is what makes it safe to redistribute inside this repository without any
licence obligations attaching to the project.

### What it covers that the synthetic generator cannot

`test/helpers/synthesize-mp3.ts` builds valid MPEG-1 Layer III frames by hand,
which is enough for most assertions and needs no encoder installed. It only ever
produces constant-bitrate streams with zeroed payloads, so four things went
untested until this file existed:

| Property                       | Value here       | Why it matters                                                                                                                                               |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Real encoder output**        | LAME 3.99r       | Genuine side info and frame chaining, not hand-assembled headers.                                                                                            |
| **VBR**                        | LAME `V2` preset | Exercises the `/^V\d/` branch of `toEncodingMode()`. Every synthetic fixture is CBR.                                                                         |
| **Fractional average bitrate** | `96227.979…` bps | A real VBR average is not an integer. This is the case that proved the service was relying on the database driver to truncate it — see `uploads/service.ts`. |
| **A real ID3v2.3 tag**         | `artist` only    | Written by a real tagger, with a syncsafe length the parser has to skip correctly.                                                                           |

It is 18.5 s of speech at 48 kHz mono, which also lands inside the duration
outlier window and scores 7/10 — a genuinely middling file rather than a
corner case.

### Refreshing it

```bash
curl -o apps/api/test/fixtures/david-graeber-voice-cc0.mp3 \
  https://upload.wikimedia.org/wikipedia/commons/1/16/David_Graeber_-_voice_-_en.mp3
shasum -a 256 apps/api/test/fixtures/david-graeber-voice-cc0.mp3   # must match the table above
```

The suite asserts the SHA-256 above, so a silently swapped or corrupted fixture
fails loudly rather than changing what the other assertions mean.
