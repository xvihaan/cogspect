# audio/

cpt's fixed narration, rendered once instead of being spoken by whatever voice
the visitor's operating system happens to ship.

Every Korean voice macOS ships is one of Apple's character voices except Yuna,
and none of them is the young, easy male this site wants — so for the lines
that never change, the browser does not get a vote.

Files here are named after the line they carry (`intro-right.mp3`,
`intro-left.mp3`, `intro-back.mp3`). The page reaches for the recording first
and falls back to the browser voice the moment one is missing or will not
play, so an unrendered line is never a broken page.

Rendered by:

    OPENAI_API_KEY=...      node tools/render-narration.mjs
    ELEVENLABS_API_KEY=...  node tools/render-narration.mjs --provider=eleven

The copy comes from `index.html`'s `#cptLines` block, which is also what the
page shows as subtitles — one source, so the audio and the text cannot drift.
**Edit the line, re-render with `--force`.**
