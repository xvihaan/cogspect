# cogspect.ai — STATUS

Updated: 2026-07-28

## What this is
Static portfolio site for **cogspect**, built from the Claude Design draft
`cogspect v2.dc.html` (project 9eb404df-b13a-4b54-8d88-ab95149fbc92).
Vanilla JS + CSS 3D transforms (no framework, no build step) — chosen over
Three.js because the design is a CSS-3D cube + 2D canvas ripple; DOM keeps
text crisp and glassmorphism native via backdrop-filter.

## Files
- `index.html` — 6 cube faces (canvas / matrix / gateway / keen / vision / v0id), fixed chrome (wordmark, glass nav, HUD, chat dock, contact overlay)
- `css/style.css` — liquid-glass styling (layered inset highlights + backdrop-filter blur/saturate/brightness), face gradients, dark-face chrome inversion (`body.on-dark`), reduced-motion support
- `js/app.js` — cube slot/NAV logic ported from the DC prototype, drag/wheel/arrow navigation, pixel-grid ripple canvas, chat keyword → face routing, toast, entrance drift

## Interactions (revised after CEO feedback rounds 1–2)
- Drag = free tumbling: Euler rx/ry accumulator, flick momentum roll (phase machine idle|drag|roll|snap|turn), settles by unwinding to nearest slot's CANON upright orientation, then re-anchors slot assignment. Rolling cube can be caught mid-roll. pointerId-filtered (multi-touch safe)
- Arrow keys / chat keywords still do exact quarter-turns (820ms)
- Mouse scroll + trackpad pinch drive continuous zoom 0.22–1.0 (rAF spring); zooming in past 0.6 mid-roll forces snap to nearest face then zooms into it
- Haptics: rendered `<input switch>` proxy (Safari 17.4+ Taptic hack, fired synchronously inside gesture handlers) + vibrate() fallback — grab/flick/settle/zoom detents/contact. No web haptic API exists for Chromium desktop
- Liquid glass v3 (CEO reverted colour haze): neutral design gradients only; hover = convex-lens bulge (scale + backdrop boost everywhere; Chromium fixed chrome additionally gets `url(#lg-convex)` displacement); always-on `#lg-lens` refraction on fixed chrome in Chromium
- Chat input routes keywords (matrix, gateway, keen, vision, v0id, contact, 한국어 동의어) to faces; unknown input gets a hint toast
- `home` button resets to front face; `contact` opens glass overlay (Esc / backdrop click closes; `inert` when hidden)
- Bottom face (v0id) inverts fixed chrome colors

## Verification
- `node --check` on app.js: pass
- Reviewer round 1: REVISE (5 findings — busy-flag deadlock, chainTimer race, overlay input leaks, toast lying when busy, hidden-overlay focusability) → all fixed
- Reviewer round 2: APPROVE (all 5 findings resolved, no regressions)
- Feature round (glass/haptics/zoom) review: APPROVE with 2 MINOR — both fixed
- Free-roll round review: REVISE (multi-pointer drag corruption MAJOR) → pointerId filtering added → APPROVE. Rotation matrices/CANON table verified analytically against CSS spec
- Feel round (weighty landing kick + EASE_TURN/EASE_SNAP, empty-space tap-to-navigate, gray glass tint): APPROVE with 1 MINOR (tap branch rotHold strand) — fixed
- Residual risk: static analysis only, no live browser run — verify visually: roll/snap feel in Safari+Chrome, Chromium lens filter perf, Taptic proxy efficacy, real two-finger behavior on touch devices

## Run
```bash
cd ~/Desktop/PROJECT/cogspect.ai
python3 -m http.server 4173 --bind 127.0.0.1
# → http://127.0.0.1:4173
```

## Next
- Real chat backend (currently keyword routing only)
- Optional: deploy target (Netlify?) — YELLOW tier, needs CEO approval
