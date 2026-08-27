#!/usr/bin/env node
/*
  Synthesises cpt's fixed narration into audio/ so the voice is a decision we
  make once rather than an accident of the visitor's operating system.

  Every Korean voice macOS ships is one of Apple's character voices except
  Yuna, and none of them is the young, easy male the site wants. These lines
  never change at runtime, so there is no reason to make a browser guess at
  them: render them here, with an engine we picked, and ship the result.

  The copy comes from index.html's #cptLines block — the same block the page
  reads — so the audio and the subtitles cannot drift apart.

  Usage
    OPENAI_API_KEY=...      node tools/render-narration.mjs
    ELEVENLABS_API_KEY=...  node tools/render-narration.mjs --provider=eleven

  Options
    --provider=openai|eleven   default: whichever key is present
    --voice=<name|id>          default: a young male for that provider
    --only=<key>               render one file, e.g. --only=intro-back
    --force                    re-render files that already exist

  The key is read from the environment at render time and never reaches the
  site: what ships is the mp3.
*/

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'audio');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

/* ---------- the copy, straight out of the page ------------------------- */

async function lines() {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const m = /<script type="application\/json" id="cptLines">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('index.html has no #cptLines block to render from');
  const data = JSON.parse(m[1]);
  const out = [];
  for (const [face, ls] of Object.entries(data.faceIntro || {})) {
    out.push({ key: `intro-${face}`, text: ls.join(' ') });
  }
  return out;
}

/* ---------- providers --------------------------------------------------

   Both return mp3. Korean is the point, so the defaults are the voices each
   engine reads Korean best with rather than the ones it is famous for.      */

const PROVIDERS = {
  openai: {
    env: 'OPENAI_API_KEY',
    // 'verse' is the lightest of the male voices; 'echo' is a shade deeper,
    // 'onyx' deeper still and reads older, which is the failure mode we hit
    // with every macOS male voice.
    voice: 'verse',
    async render(text, voice, key) {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          voice,
          input: text,
          response_format: 'mp3',
          instructions: '차분하고 밝은 20대 후반 한국인 남성. 안내하듯 또렷하게, ' +
                        '과장 없이. 문장 끝을 급하게 내리지 말 것.'
        })
      });
      if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return Buffer.from(await r.arrayBuffer());
    }
  },
  eleven: {
    env: 'ELEVENLABS_API_KEY',
    // a voice id, not a name. Pick one from the ElevenLabs voice library and
    // pass it with --voice=<id>; this is their stock young male.
    voice: 'TxGEqnHWrfWFTfGW9XjX',
    async render(text, voice, key) {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.45, similarity_boost: 0.75 }
          })
        }
      );
      if (!r.ok) throw new Error(`eleven ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return Buffer.from(await r.arrayBuffer());
    }
  }
};

function pickProvider() {
  const named = flag('provider');
  if (named) {
    if (!PROVIDERS[named]) throw new Error(`unknown provider "${named}"`);
    return named;
  }
  const found = Object.keys(PROVIDERS).find((p) => process.env[PROVIDERS[p].env]);
  if (!found) {
    throw new Error(
      'no API key in the environment. Set one of:\n' +
      Object.values(PROVIDERS).map((p) => `  ${p.env}`).join('\n')
    );
  }
  return found;
}

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  const name = pickProvider();
  const provider = PROVIDERS[name];
  const key = process.env[provider.env];
  if (!key) throw new Error(`${provider.env} is not set`);
  const voice = flag('voice', provider.voice);
  const only = flag('only');

  await mkdir(OUT, { recursive: true });
  const all = await lines();
  const todo = only ? all.filter((l) => l.key === only) : all;
  if (!todo.length) throw new Error(only ? `no line called "${only}"` : 'nothing to render');

  console.log(`${name} / ${voice} — ${todo.length} line(s)`);
  for (const { key: id, text } of todo) {
    const path = join(OUT, `${id}.mp3`);
    if (!has('force') && await exists(path)) {
      console.log(`  skip  ${id}  (exists — pass --force to replace)`);
      continue;
    }
    const audio = await provider.render(text, voice, key);
    await writeFile(path, audio);
    console.log(`  wrote ${id}.mp3  ${(audio.length / 1024).toFixed(1)} KB  "${text.slice(0, 28)}…"`);
  }
  console.log('\nAudition them, then commit audio/. The page picks them up on its own;');
  console.log('anything not rendered falls back to the browser voice as before.');
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
