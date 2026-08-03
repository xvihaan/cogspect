# cogspect.ai — STATUS

Updated: 2026-08-03

## What this is
Static portfolio site for **cogspect**, built from the Claude Design draft
`cogspect v2.dc.html` (project 9eb404df-b13a-4b54-8d88-ab95149fbc92).
Vanilla JS + CSS 3D transforms (no framework, no build step) — chosen over
Three.js because the design is a CSS-3D cube + 2D canvas ripple; DOM keeps
text crisp and glassmorphism native via backdrop-filter.

## Files
- `index.html` — 6 cube faces (cogspect / 김민혁의 포트폴리오 / Bifröst / keen / prospect / minimalid), fixed chrome (wordmark, glass nav, HUD, chat dock, contact overlay). Markup fixes: `aria-label` typo on minimalid face, bottom face kicker now distinct ("philosophy", routable)
- `css/style.css` — liquid-glass styling (layered inset highlights + backdrop-filter blur/saturate/brightness), face gradients, dark-face chrome inversion (`body.on-dark`), reduced-motion support
- `js/app.js` — rigid cube model: 3×3 orientation matrix O rendered with matrix3d(); navigation pre-multiplies O by quarter turns; faces mounted permanently; `REST` table (24 resting poses); free tumble settles via `nearestRest` BFS; arriving face gets twist-rotate to keep text readable while cube stays physically faithful. Removed: NAV/CANON/SLOT_NORMALS, rotFor, rx/ry. Added: mul/mv/rotX/rotY, twistFor, settle. Drag/wheel/arrow navigation, ripple canvas, chat routing, toast

## Interactions (rigid cube, 2026-08-03)
- **Navigation**: Arrow keys / chat keywords / exact turns do quarter-rotations pre-multiplying O by world-axis rotations (ROT.right = rotY(−90), etc.). No drift; all 24 poses reachable in ≤2 turns from any pose
- **Drag = free tumbling**: pointer delta pre-multiplies O by world-axis rotations → exponential momentum decay on release (`ROLL_DAMPING` per 60Hz frame) → settles via `nearestRest` (shortest arc to one of 24 resting poses). Can be caught mid-roll; `pointerdown` records whether it caught a roll so a tap always routes through `settle()`. pointerId-filtered (multi-touch safe). Entrance drift is rendered pre-state; O stays identity so an early keypress still turns from a square pose
- **Twist rendering**: arriving face's content rotates by θ ∈ {0,90,180,270} (`twistFor`) to stay readable. Cube's own orientation is never corrected, preserving physical fidelity. `setTwist` rewrites θ to the revolution nearest the current value (shortest arc) and shares the cube's easing curve — instant during quarter turns (the arriving face is edge-on), eased during snaps and `goHome`
- **Mouse scroll + trackpad pinch**: continuous zoom 0.22–1.0 (rAF spring); zooming in past 0.6 mid-roll forces snap then zooms
- **Haptics**: rendered `<input switch>` proxy (Safari 17.4+ Taptic) + vibrate() fallback — grab/flick/settle/zoom detents/contact
- **Glass & hover**: Liquid glass v3 (neutral gradients); hover = convex-lens bulge; Chromium gets `url(#lg-convex)` displacement filter + always-on lens refraction
- **Chat routing**: keywords (cogspect, 김민혁, bifrost, keen, prospect, minimalid, contact, 한국어) → faces; unknown input = hint toast. Contact email: cogspect@gmail.com
- **Controls**: `home` = front face; `contact` overlay (Esc/backdrop close). Minimalid face (bottom) inverts fixed chrome colors

## Hit-testing: why the orientation lives on the faces (2026-08-03)
The orientation matrix is written onto **each face**, not onto `#cube`
(`paintFaces()`); `#cube` stays an untransformed square frame. A wrapper
carrying the rotation collapses to zero projected width at every 90° resting
pose (measured: `cube rect 640,-81,0,962`), and Chrome will not hit-test into
descendants when an ancestor's box in the preserve-3d context is degenerate —
which made every project tile, both Bifröst planets and the archive link
unclickable. Rejected first, each disproved in-browser: `pointer-events: none`
on `.cube` (kills descendants too), `backface-visibility: visible`, dropping
the trailing `rotate()`, `rotateY()` instead of `matrix3d()`, `perspective:
none`, `transform-style: flat`, removing `will-change`.
Do not move the transform back onto the wrapper.

Focus follows the visible face: `setFace()` marks the other five `inert`. An
open card calls `lockChrome()`, which inerts **every** `.stage` child except
the overlays — the cube, the nav, the HUD and the chat dock are siblings, and
`.glass-nav` (z-index 60) paints above the backdrop (z-index 58), so inerting
only the cube would leave the home/contact buttons tabbable behind the modal.
`releaseChrome()` restores focus to whatever had it before the card opened.

Arrival twist is applied by `paintOne()` **before** the turn starts, while the
face is still edge-on. Folding it into the turn's transition instead makes the
face's text counter-rotate up to 180° as it swings into view.

## Verification
- `node --check` on app.js: pass
- Headless assertions (24 tests): REST table exactly 24 poses; css3d(rotY(90)) matches CSS spec; CEO's path returns to identity; all directions reversible from all 24 poses; all 6 faces ≤2 turns away; twistFor provably squares content on all 24 poses; nearestRest recovers jittered pose
- Live Chrome (headless, `test/verify.html`, 38 assertions): navigation lap; cube box non-degenerate at home AND on 90° poses; arriving face re-squared instantly rather than over the turn curve; tile hit-testable on a twisted face and clicking it opens the card; Enter on a focused tile opens it too; open card inerts the nav and the chat dock, focus moves into the card and is restored to the tile on close; Bifröst planet and archive link hit-testable; wheel over a planet reaches the zoom handler; faces not text-selectable; flick + catch-tap settling on an exact pose with the HUD matching geometry; `inert` following the landing; home squaring the front face. No JS errors
- Reviewer round: REVISE (1 blocker + 3 major + 3 minor). Blocker: veil needed NO coordinate correction (O·SLOT·rotate(twist) is identity on settled face). Majors: endDrag pointer-catch routing, twist animation shortest arc, shared easing curve. Minors: all fixed
- Residual risk: Safari (matrix3d + preserve-3d + backface-visibility untested), real touch/multi-pointer, reduced-motion, haptics/device easing feel — Chrome headless only

## Run
```bash
cd ~/Desktop/PROJECT/cogspect.ai
python3 -m http.server 4173 --bind 127.0.0.1
# → http://127.0.0.1:4173
# verification harness → http://127.0.0.1:4173/test/verify.html
```
`test/verify.html` drives the real page with synthetic events and asserts the
invariants that are easy to break (spatial memory, hit-testing through the 3D
transform, arrival twist, focus containment, zoom dead zones). Headless:
```bash
chrome --headless=new --virtual-time-budget=45000 --dump-dom \
       http://127.0.0.1:4173/test/verify.html
```
Under virtual time CSS transitions and rAF do not advance, so it reads
committed inline styles and cannot see mid-transition frames — check those by eye.

## Deployment
- Live at **https://xvihaan.github.io/cogspect/** (GitHub Pages, branch `main`, root, HTTPS enforced)
- Repo: https://github.com/xvihaan/cogspect (public). To update: commit → `git push` → Pages redeploys automatically (~1 min)
- Custom domain: not yet purchased. When bought, add 4 GitHub Pages A records + `CNAME www → xvihaan.github.io` at the registrar, then set the domain in repo Settings → Pages

## Chat — b3ta intelligence (2026-07-28)
- Client-side RAG over data/projects.json + data/knowledge.json (keyword scoring, Korean particle shedding); top hit decides the cube face → auto-navigate; matched project tiles get .mark glow
- Answers from local b3ta model: cogspect → Earthpace backend POST /api/v1/chat/generic (stateless passthrough, CORS ok) → mlx model server :8001 (local gemma-4-e2b 4bit, ~3s warm)
- Endpoint override: localStorage 'cogspect.chat.endpoint'; optional auth: backend env EARTHPACE_GENERIC_CHAT_TOKEN + localStorage 'cogspect.chat.token' (X-Cogspect-Key)
- Unreachable model → retrieval-template fallback answer (public GitHub Pages visitors always get fallback — local model not exposed)
- Ephemeral ghost bubble above chat dock: blur-materialise in, auto-dissolve 4.5s+55ms/char (cap 15s), click to dismiss
- Earthpace changes (uncommitted there): backend/app/api/chat.py + schemas/chat.py (new), main.py router, llm_service.py optional model kwarg. Start stack: `make model && make backend` in Earthpace
- Known untested: LLM path from the deployed HTTPS origin in real browsers (Chrome PNA / Safari mixed content may silently force fallback)

## Next
- Fill real portfolio copy in data/projects.json (CEO)
- Custom domain: deliberately skipped for now — CEO favors cogspect.com (safe) or cogspect.xyz (fits spatial brand); all TLDs confirmed unregistered as of 2026-07-28
- Optional: expose LLM publicly via tunnel (Tailscale Funnel / cloudflared) or cloud API if wanted later
