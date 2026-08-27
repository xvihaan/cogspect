/* cogspect — spatial cube interface */
(() => {
  'use strict';

  const ROT_ZOOM = 0.34;            // zoom-out clamp while the cube is in motion
  const MIN_ZOOM = 0.22;            // deepest user zoom-out
  const ROT_MS = 820;               // quarter-turn duration (arrows / chat)
  const SETTLE_MS = ROT_MS + 60;
  const ROLL_DAMPING = 0.945;       // momentum decay per 60Hz frame
  const ROLL_MIN_V = 0.06;          // deg/frame — below this the roll snaps
  const FLICK_V = 0.35;             // deg/frame — release speed that starts a roll
  const EASE_TURN = 'cubic-bezier(.36,.06,.14,1)';   // fluid glide, firm landing
  const EASE_SNAP = 'cubic-bezier(.22,.86,.16,1.02)';
  const KICK = 0.03;                // landing "thunk": brief scale dip on settle
  const SWIPE_ZOOM = 0.7;           // at or above this a drag swipes one face
  const SWIPE_MIN = 58;             // px of travel that commits the swipe

  /* ---------- rigid cube ----------
     Each face is bolted to its own side of the cube and never moves. The
     cube carries a single 3×3 orientation matrix; every navigation step
     pre-multiplies it by a quarter turn about a WORLD axis, so the faces
     keep fixed positions in space: front → right → up → down → left brings
     you back to front, exactly like turning a real cube in your hand. */

  // where each face is mounted on the cube
  const SLOT = {
    front: 'rotateY(0deg)', right: 'rotateY(90deg)', left: 'rotateY(-90deg)',
    back: 'rotateY(180deg)', top: 'rotateX(90deg)', bottom: 'rotateX(-90deg)'
  };
  // outward normal of each face (CSS coords: x right, y down, z toward viewer)
  const NORMAL = {
    front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0],
    left: [-1, 0, 0], top: [0, -1, 0], bottom: [0, 1, 0]
  };
  // each face's "up" direction in cube-local coords (= its slot × screen-up)
  const UP = {
    front: [0, -1, 0], back: [0, -1, 0], right: [0, -1, 0],
    left: [0, -1, 0], top: [0, 0, -1], bottom: [0, 0, 1]
  };
  const LABELS = {
    front: 'cogspect', right: 'portfolio', left: 'Bifröst',
    back: 'keen', top: 'prospect', bottom: 'minimalid'
  };

  /* ---------- rotation math (row-major 3×3, v' = M·v) ---------- */

  const ID = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  function mul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
      }
    }
    return C;
  }
  function mv(M, v) {
    return [
      M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
      M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
      M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]
    ];
  }
  function rotX(deg) {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[1, 0, 0], [0, c, -s], [0, s, c]];
  }
  function rotY(deg) {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  }
  const roundM = (M) => M.map((r) => r.map((n) => Math.round(n)));

  // CSS matrix3d() is column-major
  function css3d(M) {
    const n = (v) => v.toFixed(6);
    return `matrix3d(${n(M[0][0])},${n(M[1][0])},${n(M[2][0])},0,` +
      `${n(M[0][1])},${n(M[1][1])},${n(M[2][1])},0,` +
      `${n(M[0][2])},${n(M[1][2])},${n(M[2][2])},0,0,0,0,1)`;
  }

  // quarter turns about the world axes — exact integers, so orientations
  // stay drift-free no matter how many turns are chained
  const DIR = {
    right: roundM(rotY(-90)), left: roundM(rotY(90)),
    up: roundM(rotX(-90)), down: roundM(rotX(90))
  };
  const DIRS = ['right', 'left', 'up', 'down'];

  // the 24 poses a cube can rest in; a free tumble settles on the nearest
  const REST = (() => {
    const key = (M) => M.map((r) => r.join()).join('|');
    const seen = new Map([[key(ID), ID]]);
    const queue = [ID];
    while (queue.length) {
      const cur = queue.pop();
      for (const g of [DIR.up, DIR.right]) {
        const next = roundM(mul(g, cur));
        if (!seen.has(key(next))) { seen.set(key(next), next); queue.push(next); }
      }
    }
    return [...seen.values()];
  })();

  // which face looks at the viewer under orientation M
  function frontFaceFor(M) {
    let best = 'front', bz = -Infinity;
    for (const f in NORMAL) {
      const z = mv(M, NORMAL[f])[2];
      if (z > bz) { bz = z; best = f; }
    }
    return best;
  }

  // In-plane spin that makes a face read upright once it faces the viewer.
  // The cube itself is never corrected — only the content on the arriving
  // face — so spatial positions stay physically honest.
  function twistFor(M, face) {
    const w = mv(M, UP[face]);
    const deg = -Math.atan2(w[0], -w[1]) * 180 / Math.PI;
    return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  }

  // nearest resting pose + how far away it is, in degrees
  function nearestRest(M) {
    let best = REST[0], bs = -Infinity;
    for (const T of REST) {
      let s = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += T[i][j] * M[i][j];
      if (s > bs) { bs = s; best = T; }
    }
    const cos = Math.max(-1, Math.min(1, (bs - 1) / 2));
    return { M: best, angle: Math.acos(cos) * 180 / Math.PI };
  }

  // Portfolio content lives in data/projects.json — edit that file to add
  // or change projects; no code changes needed. Loaded at boot.
  let PROJECTS = [];

  const stage = document.getElementById('stage');
  const zoomWrap = document.getElementById('zoomWrap');
  const cube = document.getElementById('cube');
  const grid = document.getElementById('grid');
  const indicator = document.getElementById('faceIndicator');
  const hint = document.getElementById('hudHint');
  const overlay = document.getElementById('contactOverlay');
  const toast = document.getElementById('toast');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // phase: idle | drag (pointer held) | roll (momentum) | snap (settling) | turn (quarter-turn)
  let phase = 'idle';
  let cur = 'front';
  let D = 0;
  let O = ID;                       // cube orientation (rigid body)
  let vx = 0, vy = 0;               // roll velocity about world X / Y (deg per 60Hz frame)
  let drag = null;
  const faceEls = {};
  const twist = { front: 0, back: 0, right: 0, left: 0, top: 0, bottom: 0 };
  let settleTimer = 0, chainTimer = 0, toastTimer = 0, pulseTimer = 0, snapTimer = 0;
  let hintDismissed = false;

  // zoom spring: zoomTarget is the user's level, rotHold clamps it down
  // to ROT_ZOOM while the cube is in motion.
  let zoomCur = 0.36;
  let zoomTarget = 1;
  let rotHold = false;
  let kick = 0;                     // decaying landing impulse

  // Chromium supports SVG displacement in backdrop-filter (lens refraction)
  if (/Chrome\//.test(navigator.userAgent)) document.body.classList.add('lens');

  /* ---------- haptics ----------
     macOS Safari 17.4+: toggling an <input switch> fires the Force Touch
     Taptic Engine. The proxy must be rendered (not display:none / opacity:0)
     and the toggle should happen synchronously inside a user gesture, so
     haptics are fired from event handlers wherever possible. Mobile falls
     back to vibrate(); Chromium desktop has no haptic API. */

  const hapticEl = document.createElement('input');
  hapticEl.type = 'checkbox';
  hapticEl.setAttribute('switch', '');
  hapticEl.tabIndex = -1;
  hapticEl.setAttribute('aria-hidden', 'true');
  hapticEl.className = 'haptic-proxy';
  document.body.appendChild(hapticEl);

  let lastHaptic = 0;
  function haptic(gap = 90) {
    const now = performance.now();
    if (now - lastHaptic < gap) return;
    lastHaptic = now;
    if (navigator.vibrate) navigator.vibrate(6);
    try { hapticEl.click(); } catch (_) { /* no-op */ }
  }

  /* ---------- focus containment ----------
     The overlays are siblings of the cube, the nav, the HUD and the chat dock
     inside .stage, and .glass-nav paints above the backdrop — so an open card
     has to inert every sibling, not just the cube, or Tab walks straight out
     of the dialog and lands on the home button. */

  let lastFocus = null;

  function lockChrome(on) {
    if (on && !lastFocus) lastFocus = document.activeElement;
    for (const el of stage.children) {
      if (el.classList.contains('overlay')) continue;
      el.inert = on;
    }
  }

  function releaseChrome() {
    if (overlayOpen()) return;                  // the other card is still up
    lockChrome(false);
    if (lastFocus && lastFocus.isConnected && !lastFocus.closest('[inert]')) lastFocus.focus();
    lastFocus = null;
  }

  /* ---------- portfolio grass field ---------- */

  const grass = document.getElementById('grassField');
  const tileTip = document.getElementById('tileTip');
  const projOverlay = document.getElementById('projectOverlay');
  const projArt = document.getElementById('projectArt');
  const projTag = document.getElementById('projectTag');
  const projTitle = document.getElementById('projectTitle');
  const projTagline = document.getElementById('projectTagline');
  const projDesc = document.getElementById('projectDesc');
  const projSections = document.getElementById('projectSections');
  const projPoints = document.getElementById('projectPoints');
  const projStack = document.getElementById('projectStack');
  const projLink = document.getElementById('projectLink');
  const projMeta = document.getElementById('projectMeta');
  const projScroll = document.getElementById('projectScroll');

  // Clean white canvas by default: the tile texture (.grass-veil) is only
  // revealed around the cursor via a CSS mask; six always-visible silver
  // pixels are placed at viewport-relative fractions.
  const grassVeil = document.getElementById('grassVeil');
  let grassKey = '';
  let projTiles = [];
  let tileTones = null;

  /* The portfolio face is a contribution-graph homage, so the project pixels
     and the background grid have to be the same object: same cell size, same
     radius (css .grass-veil / .cell--proj), and the same lattice. GRASS_CELL
     and GRASS_GAP must match the values the stylesheet draws with. */
  const GRASS_CELL = 17, GRASS_GAP = 6;
  const GRASS_PITCH = GRASS_CELL + GRASS_GAP;

  // fraction → the centre of the nearest background cell, back as a fraction
  function snapCell(frac, size) {
    const c = Math.round((frac * size - GRASS_CELL / 2) / GRASS_PITCH);
    return (c * GRASS_PITCH + GRASS_CELL / 2) / size;
  }

  function buildGrass() {
    const W = window.innerWidth, H = window.innerHeight;
    const w = grass.clientWidth || Math.max(W, H);
    const key = `${W}x${H}`;
    if (key === grassKey) return;
    grassKey = key;
    if (!tileTones || tileTones.length < PROJECTS.length) {
      // an even mix of tones, shuffled once per visit
      const pool = [];
      while (pool.length < PROJECTS.length) pool.push('white', 'silver', 'dark');
      tileTones = pool.sort(() => Math.random() - 0.5);
    }
    grass.querySelectorAll('.cell--proj, .cell-label').forEach((c) => c.remove());
    projTiles = [];
    PROJECTS.forEach((p, i) => {
      // fx/fy are fractions of the VISIBLE viewport, remapped into the S×S
      // face so tiles stay on-screen in both orientations
      // land on an actual cell of the background grid — a project pixel that
      // sits between cells reads as a smudge, not as a planted square
      const gx = snapCell(0.5 + (p.fx - 0.5) * (W / w), w);
      const gy = snapCell(0.5 + (p.fy - 0.5) * (H / w), w);
      const t = document.createElement('div');
      t.className = 'cell--proj';
      t.dataset.project = p.id;
      t.dataset.tone = tileTones[i];
      t.setAttribute('role', 'button');
      t.setAttribute('tabindex', '0');
      t.setAttribute('aria-label', `${p.title} — ${p.tagline}`);
      t.style.left = `${(gx * w).toFixed(1)}px`;
      t.style.top = `${(gy * w).toFixed(1)}px`;
      grass.appendChild(t);

      // the project's name, on screen without hovering. It hangs BELOW the
      // pixel while .tile-tip sits above it, so the two never collide.
      const lab = document.createElement('div');
      lab.className = 'cell-label';
      lab.innerHTML = `<b></b><i></i>`;
      lab.firstChild.textContent = p.title;
      lab.lastChild.textContent = p.tagline || '';
      lab.style.left = `${clampToView(gx * w, 92, w, W).toFixed(1)}px`;
      lab.style.top = `${(gy * w).toFixed(1)}px`;
      grass.appendChild(lab);

      projTiles.push({ el: t, gx, gy });
    });
    buildAmbient(w);
  }

  /* A lattice is just a grid; a lattice whose cells carry different weights
     reads as a record of activity, which is the whole point of the grass
     homage. These cells are decoration — they carry no data and never take
     a pointer — but they are what turns six dots in a void into a graph. */
  const AMB_COUNT = 150;
  function buildAmbient(w) {
    const prev = grass.querySelector('.grass-amb');
    if (prev) prev.remove();
    const cells = Math.floor(w / GRASS_PITCH);
    const idx = (px) => Math.round((px - GRASS_CELL / 2) / GRASS_PITCH);
    const taken = new Set(projTiles.map((t) => `${idx(t.gx * w)},${idx(t.gy * w)}`));
    // the name hanging under each project pixel has to stay legible, so the
    // ambient cells keep out of the box the label occupies
    const boxes = projTiles.map((t) => ({
      x0: t.gx * w - 92, x1: t.gx * w + 92, y0: t.gy * w + 6, y1: t.gy * w + 54
    }));
    const frag = document.createDocumentFragment();
    let placed = 0, guard = 0;
    while (placed < AMB_COUNT && guard++ < AMB_COUNT * 12) {
      // Spread wide and only slightly centre-weighted: a tight gaussian piles
      // cells on top of each other, and once the cloud is blurred those piles
      // merge into one dark patch instead of reading as scattered activity.
      const cx = Math.floor(cells * (0.5 + (Math.random() + Math.random() - 1) * 0.52));
      const cy = Math.floor(cells * (0.5 + (Math.random() + Math.random() - 1) * 0.52));
      const key = `${cx},${cy}`;
      if (taken.has(key)) continue;
      const px = cx * GRASS_PITCH + GRASS_CELL / 2, py = cy * GRASS_PITCH + GRASS_CELL / 2;
      if (boxes.some((b) => px > b.x0 && px < b.x1 && py > b.y0 && py < b.y1)) continue;
      taken.add(key);
      const level = 1 + Math.floor(Math.random() * Math.random() * 3);   // mostly faint
      const a = 0.18 + level * 0.11;
      const el = document.createElement('div');
      el.className = 'cell--amb';
      el.dataset.level = level;
      el.style.left = `${px.toFixed(1)}px`;
      el.style.top = `${py.toFixed(1)}px`;
      el.style.setProperty('--a', a.toFixed(2));
      frag.appendChild(el);
      placed++;
    }
    // one wrapper carries the blur for the whole cloud: it composites as a
    // single layer, and blurring per-cell would cost 200 of them
    const wrap = document.createElement('div');
    wrap.className = 'grass-amb';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.appendChild(frag);
    grass.insertBefore(wrap, grass.firstChild);
  }

  /* Only the middle W px of the S×S face are on screen, so anything with real
     width — a label, a tip — has to be kept inside that slice or it renders
     off the edge of the display. */
  function clampToView(x, half, S, W) {
    const lo = (S - W) / 2 + half, hi = (S + W) / 2 - half;
    return hi <= lo ? S / 2 : Math.max(lo, Math.min(hi, x));
  }

  /* Five seconds of "here is what is planted here", then the face goes back
     to being a clean field. Re-entering the face runs it again. */
  const REVEAL_MS = 5000;
  let revealTimer = null;
  function revealProjects() {
    const face = faceEls.right;
    if (!face || reducedMotion.matches) return;
    clearTimeout(revealTimer);
    face.classList.add('reveal');
    revealTimer = setTimeout(() => face.classList.remove('reveal'), REVEAL_MS);
  }

  function projectOf(el) {
    const cell = el.closest && el.closest('.cell--proj');
    return cell ? PROJECTS.find((p) => p.id === cell.dataset.project) : null;
  }

  function showTip(cell, p) {
    // the face's own kicker already says to click, so the tip stays title + line
    tileTip.innerHTML = `<strong>${p.title}</strong><span>${p.tagline}</span>`;
    const half = 124;
    const x = clampToView(cell.offsetLeft + cell.offsetWidth / 2, half,
      grass.clientWidth || Math.max(window.innerWidth, window.innerHeight), window.innerWidth);
    tileTip.style.left = `${x}px`;
    tileTip.style.top = `${cell.offsetTop}px`;
    tileTip.classList.add('show');
  }
  function hideTip() { tileTip.classList.remove('show'); }

  grass.addEventListener('mouseover', (e) => {
    const p = projectOf(e.target);
    if (p) showTip(e.target.closest('.cell--proj'), p);
  });
  grass.addEventListener('mouseout', (e) => {
    if (projectOf(e.target)) hideTip();
  });
  grass.addEventListener('click', (e) => {
    const p = projectOf(e.target);
    if (p) { hideTip(); openProject(p); }
  });
  grass.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const p = projectOf(e.target);
    if (p) { e.preventDefault(); openProject(p); }
  });

  function openProject(p) {
    projArt.className = `project-art art--${p.id}`;
    // no artwork yet → drop the banner rather than show an empty grey box
    projArt.style.display = p.image ? '' : 'none';
    projArt.style.backgroundImage = p.image ? `url(${p.image})` : '';
    projArt.style.backgroundSize = p.image ? 'cover' : '';
    projArt.style.backgroundPosition = p.image ? 'center' : '';
    projArt.style.backgroundRepeat = p.image ? 'no-repeat' : '';
    projTag.textContent = p.tag;
    projTitle.textContent = p.title;
    projTagline.textContent = p.tagline;
    projDesc.textContent = p.desc;
    projSections.innerHTML = (p.sections || [])
      .map((s) => `${s.heading ? `<h3>${s.heading}</h3>` : ''}<p>${s.text}</p>`)
      .join('');
    projPoints.innerHTML = (p.points || []).map((pt) => `<li>${pt}</li>`).join('');
    // meta: [{label, value}] — 기간 / 참여 인원 / 담당 같은 고정 사실
    projMeta.innerHTML = (p.meta || [])
      .map((m) => `<dt>${m.label}</dt><dd>${m.value}</dd>`).join('');
    // stack: a flat array, or {category: [items]} for a labelled row per group
    projStack.innerHTML = Array.isArray(p.stack)
      ? (p.stack || []).map((s) => `<span>${s}</span>`).join('')
      : Object.entries(p.stack || {}).map(([label, items]) =>
        `<div class="chip-row"><span class="chip-label">${label}</span>`
        + `<div class="chips">${items.map((s) => `<span>${s}</span>`).join('')}</div></div>`).join('');
    projStack.classList.toggle('chips', Array.isArray(p.stack));
    if (p.link) {
      projLink.textContent = p.link.label;
      projLink.href = p.link.url;
      projLink.classList.remove('hidden');
    } else {
      projLink.classList.add('hidden');
    }
    projOverlay.classList.add('open');
    projOverlay.setAttribute('aria-hidden', 'false');
    projOverlay.inert = false;
    const card = projOverlay.querySelector('.project-card');
    projScroll.scrollTop = 0;
    lockChrome(true);
    card.focus();
    haptic();
  }

  function closeProject() {
    projOverlay.classList.remove('open');
    projOverlay.setAttribute('aria-hidden', 'true');
    projOverlay.inert = true;
    releaseChrome();
  }
  function projectOpen() {
    return projOverlay.classList.contains('open');
  }

  projOverlay.addEventListener('click', (e) => {
    if (e.target === projOverlay) closeProject();
  });
  document.getElementById('projectClose').addEventListener('click', closeProject);

  /* ---------- cube geometry ---------- */

  /* The orientation rides on the FACES, never on the cube wrapper.
     A wrapper carrying the rotation collapses to zero projected width at
     every 90° resting pose, and a browser will not hit-test through an
     ancestor whose box is degenerate — that made every project tile and
     planet unclickable. Leaving the wrapper as a plain square keeps the
     whole visible face clickable, since face box and wrapper box coincide. */

  let lastTr = '';
  let drifting = true;              // the entrance tilt is still the rendered state

  // Repaint a single face immediately, without a transition. Used to re-square
  // an arriving face while it is still edge-on, so its content never spins in
  // view. Invalidates the transition cache so the next full paint rewrites it.
  function paintOne(face, M) {
    const el = faceEls[face];
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform = `translateZ(${-D}px) ${css3d(M || O)} ${SLOT[face]} `
      + `translateZ(${D}px) rotate(${twist[face]}deg)`;
    // Force the style flush. Without it this write is coalesced with the next
    // one in the same task and never becomes the transition's start value, so
    // the twist would silently ride the turn's curve instead of preceding it.
    void el.offsetWidth;
    lastTr = '';
  }

  function paintFaces(animate, ms, ease, M) {
    const tr = (animate && !reducedMotion.matches)
      ? `transform ${ms || ROT_MS}ms ${ease || EASE_TURN}`
      : 'none';
    const m = css3d(M || O);              // formatted once, shared by all six
    const back = `translateZ(${-D}px) `;
    const out = ` translateZ(${D}px) rotate(`;
    for (const name in faceEls) {
      const el = faceEls[name];
      if (tr !== lastTr) el.style.transition = tr;
      el.style.transform = back + m + ' ' + SLOT[name] + out + twist[name] + 'deg)';
    }
    lastTr = tr;
  }

  function mountFaces() {
    cube.querySelectorAll('[data-face]').forEach((f) => { faceEls[f.dataset.face] = f; });
    paintFaces(false);
  }

  // Stored only — the next paint applies it, so a face's twist and the cube's
  // rotation always animate as one transform on one curve. The angle is
  // rewritten to the revolution nearest the current one, so a 0° → 270°
  // correction spins -90° instead of taking the long way round.
  function setTwist(face, deg) {
    const from = twist[face];
    twist[face] = deg + 360 * Math.round((from - deg) / 360);
  }

  function applyCube(animate, ms, ease) { paintFaces(animate, ms, ease); }
  function applyFree() { paintFaces(false); }

  function layout() {
    const W = window.innerWidth, H = window.innerHeight, S = Math.max(W, H);
    D = S / 2;
    cube.style.width = `${S}px`;
    cube.style.height = `${S}px`;
    cube.style.left = `${(W - S) / 2}px`;
    cube.style.top = `${(H - S) / 2}px`;
    mountFaces();                    // re-queries the faces and repaints them
  }

  /* The notification bar rides on its own face, so while the cube is turning
     you would otherwise watch it swing into frame edge-on. Only a face that
     has actually landed square carries .landed, and the bar fades in off
     that — which is why this is cleared the moment any motion starts and set
     again only in setFace(), i.e. exactly on settle. */
  function setLanded(face) {
    for (const n in faceEls) faceEls[n].classList.toggle('landed', n === face);
  }
  function clearLanded() { setLanded(null); }

  function setFace(face) {
    cur = face;
    setLanded(face);
    // the gate only gets built once — after that the bridge simply stands
    if (face === 'left' && faceEls.left) faceEls.left.classList.add('bridged');
    // arriving at the portfolio shows the visitor where the six projects are,
    // then lets them settle back into the field — nothing stays lit
    if (face === 'right') revealProjects();
    if (face === 'back') teaseSlab();
    indicator.textContent = LABELS[face];
    document.body.classList.toggle('on-dark', face === 'bottom');
    // Faces pointing away are still in the DOM, so without this the Tab key
    // walks into tiles and links the visitor cannot see.
    for (const name in faceEls) faceEls[name].inert = name !== face;
  }

  /* ---------- free roll: nearest-face detection & snap ---------- */

  function landThunk() {
    if (!reducedMotion.matches) kick = KICK;
    haptic();
  }

  function settle(face) {
    applyCube(false);
    setFace(face);
    vx = 0; vy = 0;
    rotHold = false;
    phase = 'idle';
    landThunk();
  }

  // Roll to rest: fall onto the nearest of the cube's 24 resting poses along
  // the shortest arc — the cube keeps whatever side it tumbled onto.
  function beginSnap() {
    if (phase !== 'drag' && phase !== 'roll') return;
    phase = 'snap';
    clearTimeout(snapTimer);
    const rest = nearestRest(O);
    const face = frontFaceFor(rest.M);
    const ms = Math.max(280, Math.min(780, rest.angle * 8));
    O = rest.M;
    setTwist(face, twistFor(O, face));
    if (rest.angle < 0.5 || reducedMotion.matches) { settle(face); return; }
    applyCube(true, ms, EASE_SNAP);
    snapTimer = setTimeout(() => settle(face), ms + 40);
  }

  /* ---------- quarter-turn navigation (arrows / chat) ---------- */

  function commit(dir) {
    clearTimeout(settleTimer);
    clearTimeout(pulseTimer);
    clearLanded();
    const target = mul(DIR[dir], O);
    const next = frontFaceFor(target);
    // A paint may still be animating (the entrance glide). Land it first: the
    // instant re-square below would otherwise start the arriving face from the
    // settled pose while the other five start from the interpolated one, and
    // the cube would visibly split for the whole turn.
    const el = faceEls[next];
    if (el && el.getAnimations && el.getAnimations().length) paintFaces(false);
    // the arriving face is edge-on right now, so re-square it instantly — if it
    // rode the turn's curve instead, its text would spin as the face swings in
    setTwist(next, twistFor(target, next));
    paintOne(next, O);
    O = target;
    phase = 'turn';
    rotHold = true;
    haptic();
    applyCube(true);
    settleTimer = setTimeout(() => settle(next), SETTLE_MS);
  }

  function dismissHint() {
    if (hintDismissed) return;
    hintDismissed = true;
    hint.classList.add('hidden');
  }

  function step(dir) {
    if (phase !== 'idle') return;
    dismissHint();
    commit(dir);
  }

  function pulseZoom() {
    clearTimeout(pulseTimer);
    rotHold = true;
    pulseTimer = setTimeout(() => { rotHold = false; }, 420);
  }

  function navigateTo(face) {
    if (phase !== 'idle') return false;
    if (face === cur) {
      pulseZoom();
      return true;
    }
    clearTimeout(chainTimer);
    // whichever way the cube is currently held, find the turn that lands on it
    const dir = DIRS.find((d) => frontFaceFor(mul(DIR[d], O)) === face);
    if (dir) { step(dir); return true; }
    // opposite face — two quarter turns along whichever axis reaches it
    const d2 = DIRS.find((d) => frontFaceFor(mul(DIR[d], mul(DIR[d], O))) === face);
    if (!d2) return false;
    step(d2);
    chainTimer = setTimeout(() => { if (cur !== face && phase === 'idle') step(d2); }, SETTLE_MS + 80);
    return true;
  }

  function goHome() {
    clearTimeout(settleTimer);
    clearTimeout(chainTimer);
    clearTimeout(snapTimer);
    clearTimeout(pulseTimer);
    drag = null;
    stage.classList.remove('dragging');
    O = ID; vx = 0; vy = 0;
    setTwist('front', 0);
    setFace('front');
    applyCube(true);
    closeContact();
    closeProject();
    haptic();
    pulseZoom();
    phase = 'turn';
    settleTimer = setTimeout(() => { phase = 'idle'; }, SETTLE_MS);
  }

  /* ---------- contact overlay ---------- */

  function contactOpen() {
    return overlay.classList.contains('open');
  }
  function overlayOpen() {
    return contactOpen() || projectOpen();
  }
  function openContact() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.inert = false;
    lockChrome(true);
    overlay.querySelector('.contact-card').focus();
  }
  function closeContact() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.inert = true;
    releaseChrome();
  }
  function toggleContact() {
    haptic();
    contactOpen() ? closeContact() : openContact();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeContact();
  });

  document.getElementById('homeBtn').addEventListener('click', goHome);
  document.getElementById('contactBtn').addEventListener('click', toggleContact);

  /* ---------- drag ----------
     Two modes, chosen by how far away the cube is:
     · zoomed in (a face fills the view) — a drag is a swipe. One gesture
       turns exactly one face, the same quarter turn the arrow keys do.
     · zoomed out (the whole cube is in frame) — a drag tumbles it freely,
       with momentum and a snap onto the nearest resting pose. */

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, a, textarea, form, .cell--proj, .ghost-msg, .keen-slab, .face-banner--handle')) return;
    if (overlayOpen()) return;
    if (phase !== 'idle' && phase !== 'roll') return;   // can catch a rolling cube
    clearTimeout(chainTimer);
    clearTimeout(pulseTimer);
    const caught = phase === 'roll';        // grabbed a cube that was still rolling
    // decided once, at grab time, so the mode can't flip mid-gesture
    // judged on zoomTarget, the level the visitor actually chose — zoomCur is
    // mid-spring during the entrance and while a turn holds the cube back
    const swipe = !caught && phase === 'idle' && zoomTarget >= SWIPE_ZOOM;
    if (!swipe) { phase = 'drag'; clearLanded(); }
    vx = 0; vy = 0;
    drag = {
      id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(),
      moved: false, acc: 0, caught,
      swipe, sx: e.clientX, sy: e.clientY, turned: false
    };
    stage.classList.add('dragging');
    haptic(140);
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;

    if (drag.swipe) {
      if (drag.turned) return;              // one face per gesture, then done
      const tx = e.clientX - drag.sx, ty = e.clientY - drag.sy;
      if (Math.max(Math.abs(tx), Math.abs(ty)) < SWIPE_MIN) return;
      drag.turned = true;
      dismissHint();
      // the surface follows the pointer: drag left and the right face arrives
      step(Math.abs(tx) > Math.abs(ty)
        ? (tx < 0 ? 'right' : 'left')
        : (ty < 0 ? 'down' : 'up'));
      return;
    }

    if (!drag.moved) {
      drag.acc += Math.hypot(dx, dy);
      if (drag.acc > 6) {
        drag.moved = true;
        rotHold = true;
        dismissHint();
      } else return;
    }
    const k = 90 / (Math.min(window.innerWidth, window.innerHeight) * 0.45);
    // drag pulls the cube surface with the pointer: dragging left reveals
    // the right face (touch-natural), matching swipe semantics. Both turns
    // are about world axes, so the cube tumbles as one rigid body.
    O = mul(mul(rotX(-dy * k), rotY(dx * k)), O);
    const now = performance.now();
    const dt = Math.max(8, now - drag.t);
    drag.t = now;
    const f = 16 / dt;                       // normalise to deg per 60Hz frame
    vx = vx * 0.6 + (-dy * k * f) * 0.4;
    vy = vy * 0.6 + (dx * k * f) * 0.4;
    applyFree();
  });

  // Tap on the empty stage around a zoomed-out cube → turn toward that side.
  function emptySpaceDir(px, py) {
    const W = window.innerWidth, H = window.innerHeight, S = Math.max(W, H);
    const half = (S * zoomCur) / 2;
    const dx = px - W / 2, dy = py - H / 2;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= half + 8) return null;   // on the cube
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy < 0 ? 'up' : 'down');
  }

  function endDrag(e, cancelled) {
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    stage.classList.remove('dragging');
    if (d.swipe) {
      // too short to commit a turn — fall back to the empty-space tap
      if (!d.turned && !cancelled) {
        const dir = emptySpaceDir(d.x, d.y);
        if (dir) step(dir);
      }
      return;
    }
    if (phase !== 'drag') return;
    if (!d.moved) {
      if (d.caught) {
        beginSnap();                 // caught a rolling cube, released in place
      } else {
        // the cube was already settled, so this was a plain tap
        phase = 'idle';
        rotHold = false;
        // only if the entrance drift never got its own paint — otherwise this
        // would hard-cut the drift-to-square glide mid-flight
        if (drifting) { drifting = false; applyCube(false); }
        if (!cancelled) {
          const dir = emptySpaceDir(d.x, d.y);
          if (dir) step(dir);
        }
      }
      return;
    }
    if (!reducedMotion.matches && Math.hypot(vx, vy) > FLICK_V) {
      phase = 'roll';
      haptic();
    } else {
      beginSnap();
    }
  }
  window.addEventListener('pointerup', (e) => endDrag(e));
  window.addEventListener('pointercancel', (e) => endDrag(e, true));
  window.addEventListener('blur', () => endDrag(null, true));

  /* ---------- wheel / pinch → continuous zoom ----------
     Mouse scroll and trackpad pinch (ctrlKey wheel) both drive the zoom
     level: fully in = current face fills the view, out = the whole cube
     shrinks into the stage. Zooming in while the cube rolls free makes it
     settle onto the nearest face first. */

  let lastDetent = null;

  window.addEventListener('wheel', (e) => {
    // only surfaces that scroll or type get the wheel; links and buttons on a
    // face must not swallow it, or the cursor sits in a zoom dead zone
    if (e.target.closest && e.target.closest('input, textarea, .project-card')) return;
    e.preventDefault();
    if (overlayOpen()) return;
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 120 : 1);
    const gain = e.ctrlKey ? 0.011 : 0.0016;      // ctrlKey = trackpad pinch
    const prev = zoomTarget;
    zoomTarget = Math.min(1, Math.max(MIN_ZOOM, zoomTarget - dy * gain));
    if (zoomTarget !== prev) {
      dismissHint();
      if (phase === 'roll' && zoomTarget > 0.6) beginSnap();
      const detent = Math.round((zoomTarget - MIN_ZOOM) / 0.13);
      if (detent !== lastDetent) { lastDetent = detent; haptic(70); }
    } else if ((zoomTarget === 1 || zoomTarget === MIN_ZOOM) && Math.abs(dy) > 4) {
      haptic(300);                                 // bump at the travel ends
    }
  }, { passive: false });

  /* ---------- keyboard ---------- */

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeContact(); closeProject(); chatInput.blur(); return; }
    if (document.activeElement === chatInput) return;
    if (drag || overlayOpen()) return;
    const map = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' };
    if (map[e.key]) { e.preventDefault(); step(map[e.key]); }
  });

  /* ---------- keen specimen: a control surface, not an ornament ----------
     The design language is demonstrated instead of described — moving the
     slab across the lattice shows the refraction doing its work. What steers
     it is the "Design space" bar: the bar stays exactly where it is and the
     specimen answers to it, which is the point. This is an agent-run site,
     so its chrome should be operable rather than decorative, and a label
     that turns out to be a control says that better than a caption would.

     The slab is grabbable directly too. Discovering the bar is the reward;
     failing to move a thing that plainly looks draggable is not a lesson
     worth teaching. Both paths run the same drag. */

  const keenSlab = document.getElementById('keenSlab');
  const keenHandle = document.getElementById('keenHandle');

  /* The specimen rests hidden behind the bar — it is something you pull OUT
     of it — but nobody tries to drag a thing they cannot see. On arrival the
     bar's subtitle turns into the instruction and the specimen dips out from
     under it three times, then everything goes back to how it was.

     It stops once the visitor has actually dragged: the teaser exists to
     teach the gesture, and repeating it at someone who already knows is
     nagging, not guidance. */
  const HANDLE_HINT = keenHandle ? keenHandle.querySelector('p') : null;
  const HINT_REST = HANDLE_HINT ? HANDLE_HINT.textContent : '';
  let slabLearned = false;
  const teaseAt = [];

  function clearTease() {
    teaseAt.forEach(clearTimeout);
    teaseAt.length = 0;
    if (keenSlab) keenSlab.classList.remove('teasing');
    if (HANDLE_HINT) { HANDLE_HINT.textContent = HINT_REST; HANDLE_HINT.style.opacity = ''; }
  }

  function teaseSlab() {
    if (!keenSlab || slabLearned || reducedMotion.matches) return;
    clearTease();
    const swap = (text, at) => {
      teaseAt.push(setTimeout(() => { if (HANDLE_HINT) HANDLE_HINT.style.opacity = '0'; }, at));
      teaseAt.push(setTimeout(() => {
        if (!HANDLE_HINT) return;
        HANDLE_HINT.textContent = text;
        HANDLE_HINT.style.opacity = '';
      }, at + 260));
    };
    swap('DRAG ME', 500);
    teaseAt.push(setTimeout(() => keenSlab.classList.add('teasing'), 900));
    teaseAt.push(setTimeout(() => keenSlab.classList.remove('teasing'), 900 + 780 * 3));
    swap(HINT_REST, 900 + 780 * 3 + 200);
  }

  if (keenSlab) {
    let slabDrag = null, slabX = 0, slabY = 0;

    /* The old ±190px box barely let the slab off its own slot. The range is
       now the whole visible face: the limits are derived at grab time from
       where the slab actually sits on screen, so it can be carried anywhere
       the visitor can see, and stops at the edges instead of at an arbitrary
       distance. The bottom margin keeps it from parking under the chat dock. */
    const EDGE = 14, DOCK = 96;
    function slabLimits() {
      const r = keenSlab.getBoundingClientRect();
      const z = zoomCur || 1;
      // how far the slab may still travel, in screen px, then back to local px
      return {
        minX: slabX - (r.left - EDGE) / z,
        maxX: slabX + (window.innerWidth - EDGE - r.right) / z,
        minY: slabY - (r.top - EDGE) / z,
        maxY: slabY + (window.innerHeight - DOCK - r.bottom) / z
      };
    }
    const clamp = (v, lo, hi) => (hi <= lo ? v : Math.max(lo, Math.min(hi, v)));

    function grabSlab(e, el) {
      e.preventDefault();
      e.stopPropagation();                   // the cube must not turn under it
      slabLearned = true;                    // they know — stop demonstrating
      clearTease();
      slabDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, lim: slabLimits(), el };
      el.classList.add('dragging', 'held');
      keenSlab.classList.add('lifted');
      // Capture is an enhancement, not the mechanism: it throws when there is
      // no live pointer with this id, and the move/up listeners live on the
      // window anyway so the drag survives the pointer leaving the element.
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    }
    keenSlab.addEventListener('pointerdown', (e) => grabSlab(e, keenSlab));
    if (keenHandle) keenHandle.addEventListener('pointerdown', (e) => grabSlab(e, keenHandle));
    window.addEventListener('pointermove', (e) => {
      if (!slabDrag || e.pointerId !== slabDrag.id) return;
      // the pointer moves in screen px; the slab lives inside the zoomed face
      const L = slabDrag.lim;
      slabX = clamp(slabX + (e.clientX - slabDrag.x) / (zoomCur || 1), L.minX, L.maxX);
      slabY = clamp(slabY + (e.clientY - slabDrag.y) / (zoomCur || 1), L.minY, L.maxY);
      slabDrag.x = e.clientX; slabDrag.y = e.clientY;
      keenSlab.style.transform = `translate(${slabX.toFixed(1)}px, ${slabY.toFixed(1)}px)`;
    });
    const dropSlab = (e) => {
      if (!slabDrag || e.pointerId !== slabDrag.id) return;
      slabDrag.el.classList.remove('dragging');
      keenSlab.classList.remove('lifted');
      slabDrag = null;
    };
    window.addEventListener('pointerup', dropSlab);
    window.addEventListener('pointercancel', dropSlab);
  }

  /* ---------- pixel-grid ripples ---------- */

  const ripples = [];
  let lastRx2 = -999, lastRy2 = -999;

  window.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - lastRx2, e.clientY - lastRy2) > 26) {
      lastRx2 = e.clientX; lastRy2 = e.clientY;
      ripples.push({ x: e.clientX, y: e.clientY, t0: performance.now() });
      if (ripples.length > 16) ripples.shift();
    }
    // cursor-reveal mask on the portfolio tile veil: map viewport coords
    // into face-local space (face is S×S centered, scaled by zoomCur)
    if (cur !== 'right') return;
    const S = Math.max(window.innerWidth, window.innerHeight);
    // no twist correction needed: O · SLOT · rotate(twist) is exactly the
    // identity for a settled face, so face-local pixels are screen pixels
    const lx = S / 2 + (e.clientX - window.innerWidth / 2) / zoomCur;
    const ly = S / 2 + (e.clientY - window.innerHeight / 2) / zoomCur;
    grassVeil.style.setProperty('--mx', `${lx.toFixed(1)}px`);
    grassVeil.style.setProperty('--my', `${ly.toFixed(1)}px`);
    // tiles take on their tone when the reveal circle reaches them
    for (const t of projTiles) {
      t.el.classList.toggle('lit', Math.hypot(lx - t.gx * S, ly - t.gy * S) < 230);
    }
  });

  function drawGrid() {
    const ctx = grid.getContext('2d');
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (grid.width !== Math.round(W * dpr) || grid.height !== Math.round(H * dpr)) {
      grid.width = Math.round(W * dpr);
      grid.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, W, H);
    const now = performance.now();
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (now - ripples[i].t0 >= (ripples[i].life || 1500)) ripples.splice(i, 1);
    }
    if (!ripples.length) return;
    const P = 12;
    for (const r of ripples) {
      // pointer wakes are small, quick circles; a voice ripple is a wide slow
      // half-circle opening upward out of the chat bar, so reach, speed,
      // decay and shape all come off the ripple itself
      const R = r.R || 140;
      const age = (now - r.t0) / 1000;
      const front = age * (r.speed || 190), decay = Math.exp(-age * (r.decay || 2.2));
      if (decay < 0.02) continue;
      const x0 = Math.max(0, Math.floor((r.x - R) / P) * P), x1 = Math.min(W, r.x + R);
      const y0 = Math.max(0, Math.floor((r.y - R) / P) * P), y1 = Math.min(H, r.y + R);
      for (let gx = x0; gx < x1; gx += P) {
        for (let gy = y0; gy < y1; gy += P) {
          const dx = gx - r.x, dy = gy - r.y;
          if (r.half && dy > 0) continue;            // upper half only
          const d = Math.hypot(dx, dy);
          if (d > R) continue;
          const band = d - front;
          let w = Math.exp(-(band * band) / (r.band || 900)) * decay;
          // taper toward the horizontal so the half ripple reads as an arc
          // rising out of the bar rather than a disc cut in two
          if (r.half) w *= 0.3 + 0.7 * (-dy / (d || 1));
          w = Math.min(1, w * (r.gain || 1));
          if (w < 0.03) continue;
          const ang = Math.atan2(dy, dx);
          const off = Math.sin(d * 0.09 - age * 9) * 4 * w;
          const px = gx + Math.cos(ang) * off, py = gy + Math.sin(ang) * off;
          const s = 1.5 + w * 2;
          ctx.fillStyle = `rgba(168,173,188,${(w * 0.55).toFixed(3)})`;
          ctx.fillRect(px, py, s, s);
          ctx.fillStyle = `rgba(255,255,255,${(w * 0.8).toFixed(3)})`;
          ctx.fillRect(px, py - 1, s, 1);
        }
      }
    }
  }

  /* A ripple thrown from the top edge of the chat bar, once per spoken beat.
     It is the same pixel grid the pointer disturbs — the voice just pushes a
     bigger, slower, half-round wave through it. */
  let lastVoiceRipple = 0;
  function voiceRipple() {
    // boundary events and the steady beat both feed this; a floor keeps the
    // two from stacking into a wall of overlapping fronts
    const now = performance.now();
    if (now - lastVoiceRipple < 170) return;
    lastVoiceRipple = now;
    const r = chatForm.getBoundingClientRect();
    ripples.push({
      x: (r.left + r.right) / 2, y: r.top,
      t0: performance.now(),
      // wide enough to clear the answer bubble sitting directly above the
      // bar, or the arc is swallowed by it and never reads
      half: 1, R: 440, speed: 300, decay: 1.25, band: 3200, life: 2800,
      gain: 1.9
    });
    if (ripples.length > 20) ripples.shift();
  }

  /* ---------- render loop: momentum + zoom spring + ripples ---------- */

  let lastTick = performance.now();

  function tick() {
    const now = performance.now();
    const f = Math.min(3, (now - lastTick) / 16.7);   // frames elapsed @60Hz
    lastTick = now;

    if (phase === 'roll') {
      O = mul(mul(rotX(vx * f), rotY(vy * f)), O);
      const damp = Math.pow(ROLL_DAMPING, f);
      vx *= damp; vy *= damp;
      applyFree();
      if (Math.hypot(vx, vy) < ROLL_MIN_V) beginSnap();
    }

    const t = rotHold ? Math.min(zoomTarget, ROT_ZOOM) : zoomTarget;
    zoomCur += (t - zoomCur) * Math.min(1, 0.12 * f);
    if (reducedMotion.matches || Math.abs(t - zoomCur) < 0.0004) zoomCur = t;
    kick = kick > 0.0005 ? kick * Math.pow(0.86, f) : 0;
    zoomWrap.style.transform = `scale(${zoomCur * (1 - kick)})`;

    drawGrid();
    requestAnimationFrame(tick);
  }

  /* ---------- b3ta intelligence: RAG chat ----------
     Retrieval runs fully client-side over data/projects.json +
     data/knowledge.json. Answers come from the local b3ta model server
     (Earthpace backend passthrough); when it is unreachable the bot
     degrades to a retrieval-only template answer. */

  const CHAT_ENDPOINT = localStorage.getItem('cogspect.chat.endpoint')
    || 'http://127.0.0.1:8000/api/v1/chat/generic';
  const SYSTEM_PROMPT = '너는 cogspect 웹사이트에 상주하는 안내 지능이다. 반드시 [컨텍스트] 안의 정보만 사용해 한국어로 답한다. 2~3문장, 목록 없이 평문으로 간결하게. 컨텍스트에 없는 내용은 지어내지 말고 모른다고 답한다.';

  let KNOWLEDGE = [];
  fetch('data/knowledge.json')
    .then((r) => r.json())
    .then((d) => { KNOWLEDGE = d.chunks || []; })
    .catch((err) => console.warn('knowledge.json load failed:', err));

  const ghost = document.getElementById('ghostMsg');
  let ghostTimer = 0;
  let chatAbort = null;
  let markedTiles = [];

  function clearMarks() {
    markedTiles.forEach((el) => el.classList.remove('mark'));
    markedTiles = [];
  }
  function markProjects(ids) {
    clearMarks();
    projTiles.forEach((t) => {
      if (ids.includes(t.el.dataset.project)) {
        t.el.classList.add('mark');
        markedTiles.push(t.el);
      }
    });
  }

  /* ---------- cpt's voice ----------
     Web Speech, so there is no network call and nothing to host. Two things
     make this harder than it looks:

     · Autoplay. Browsers gate speech behind a user gesture, and they do not
       agree on how: Chrome usually lets a page-load utterance through,
       Safari never does. So a blocked greeting is not dropped — it is parked
       and spoken on the visitor's first interaction instead, and the bubble
       shows either way. Audio is never the only channel.
     · Voices load late. getVoices() is commonly empty on first call and
       fills in asynchronously, so the Korean voice is resolved at speak time
       and the list is re-read on voiceschanged.

     Ripples are driven off boundary events where the engine emits them, so
     the grid pulses on the actual words; engines that stay silent fall back
     to a steady beat for the utterance's duration. */

  const TTS = window.speechSynthesis;
  const VOICE_KEY = 'cogspect.voice';
  let voiceOn = localStorage.getItem(VOICE_KEY) !== 'off';
  let parkedSpeech = null;              // blocked by autoplay, waiting for a gesture
  let beatTimer = null, waveEnd = null;

  function koVoice() {
    const all = TTS ? TTS.getVoices() : [];
    return all.find((v) => /^ko/i.test(v.lang)) || null;
  }
  if (TTS) TTS.addEventListener('voiceschanged', koVoice);

  /* The wave is the message's own pulse, not the engine's. Driving it off
     onstart meant waiting on speech warm-up — which is hundreds of ms on the
     first utterance, and never arrives at all when autoplay refuses or the
     visitor has muted cpt — so the bubble appeared and the grid answered
     late, or not at all. It now begins on the same tick as the text. */
  function stopBeat() {
    clearInterval(beatTimer); beatTimer = null;
    clearTimeout(waveEnd); waveEnd = null;
  }
  function startWave(ms) {
    stopBeat();
    voiceRipple();                       // same tick as the bubble
    beatTimer = setInterval(voiceRipple, 560);
    waveEnd = setTimeout(stopBeat, ms);
  }

  function speak(text) {
    if (!TTS || !voiceOn || !text) return;
    // only cancel when there is something to cancel: cancel() immediately
    // followed by speak() is a well-known Chrome stall, and paying for it on
    // every utterance is exactly the delay this is trying to remove
    if (TTS.speaking || TTS.pending) TTS.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = koVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'ko-KR';
    u.rate = 1.24;                       // brisk — a guide, not a narrator
    u.pitch = 1;
    let spoke = false;
    u.onstart = () => { spoke = true; parkedSpeech = null; };
    // engines that emit boundaries pulse the grid on the actual words, over
    // the steady beat startWave() is already running
    u.onboundary = voiceRipple;
    u.onend = stopBeat;
    u.onerror = (e) => {
      if (!spoke && /not-allowed|blocked/i.test(e.error || '')) parkedSpeech = text;
    };
    TTS.speak(u);
    // Chrome reports nothing at all when it silently refuses; if the engine
    // has not started by now, treat it as blocked and wait for a gesture
    setTimeout(() => { if (!spoke && !TTS.speaking) parkedSpeech = text; }, 700);
  }

  function hushVoice() {
    if (TTS) TTS.cancel();
    stopBeat();
    parkedSpeech = null;
  }

  /* cpt speaks on its own, unprompted — so there has to be a way to stop it
     that does not involve muting the whole tab. The choice is remembered, so
     a visitor who turns it off never hears it again on this browser. */
  const voiceBtn = document.getElementById('voiceToggle');
  function paintVoiceBtn() {
    if (!voiceBtn) return;
    voiceBtn.classList.toggle('off', !voiceOn);
    voiceBtn.setAttribute('aria-pressed', String(voiceOn));
    voiceBtn.setAttribute('aria-label', voiceOn ? '음성 안내 끄기' : '음성 안내 켜기');
  }
  if (voiceBtn) {
    if (!TTS) voiceBtn.hidden = true;          // nothing to toggle
    paintVoiceBtn();
    voiceBtn.addEventListener('click', () => {
      voiceOn = !voiceOn;
      localStorage.setItem(VOICE_KEY, voiceOn ? 'on' : 'off');
      if (!voiceOn) hushVoice();
      paintVoiceBtn();
    });
  }

  // first real interaction releases anything autoplay refused
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, () => {
      if (!parkedSpeech) return;
      const t = parkedSpeech;
      parkedSpeech = null;
      speak(t);
    }, { capture: true, passive: true });
  }

  function dismissGhost() {
    clearTimeout(ghostTimer);
    stopBeat();
    ghost.classList.remove('show', 'pending');
    ghost.classList.add('leaving');
    setTimeout(() => ghost.classList.remove('leaving'), 500);
    clearMarks();
  }
  function showGhost(text, pending) {
    clearTimeout(ghostTimer);
    ghost.textContent = text;
    ghost.classList.remove('leaving');
    ghost.classList.add('show');
    ghost.classList.toggle('pending', !!pending);
    if (!pending) {
      const dur = Math.min(15000, 4500 + text.length * 55);
      startWave(dur);                    // grid moves with the text…
      speak(text);                       // …and the voice starts alongside it
      ghostTimer = setTimeout(dismissGhost, dur);
    }
  }
  ghost.addEventListener('click', () => { hushVoice(); dismissGhost(); });

  function tokenize(s) {
    return s.toLowerCase().split(/[^0-9a-z가-힣]+/).filter((t) => t.length > 1);
  }

  // question words carry no topic, so they never earn a chunk its key bonus
  const STOPKEYS = new Set([
    '어떻게', '뭐', '뭐하는', '무엇', '누구', '왜', '어떤', '있어', '있나',
    '어때', '소개', '설명', '알려', '이동'
  ]);

  function stackText(s) {
    if (!s) return '';
    if (Array.isArray(s)) return s.join(' ');
    return Object.entries(s)
      .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' ') : v}`).join(' ');
  }

  function retrieve(q) {
    const toks = tokenize(q);
    const ql = q.toLowerCase();
    const scoreText = (hay) => toks.reduce((s, t) => {
      if (hay.includes(t)) return s + t.length;
      // shed a trailing Korean particle and retry
      const st = t.length > 2 ? t.slice(0, -1) : null;
      return st && hay.includes(st) ? s + st.length : s;
    }, 0);
    const hits = [];
    for (const p of PROJECTS) {
      // stack is either a flat array or {분류: [항목]} — search both shapes,
      // and search the 성과 기여 bodies, which is where the detail lives
      const hay = [
        p.title, p.tag, p.tagline, p.desc,
        (p.points || []).join(' '),
        (p.meta || []).map((m) => m.value).join(' '),
        (p.sections || []).map((s) => `${s.heading} ${s.text}`).join(' '),
        stackText(p.stack)
      ].join(' ').toLowerCase();
      const s = scoreText(hay);
      if (s > 1) hits.push({ kind: 'project', score: s, face: 'right', ref: p });
    }
    for (const c of KNOWLEDGE) {
      const hay = [c.title, c.text, (c.keys || []).join(' ')].join(' ').toLowerCase();
      let s = scoreText(hay);
      // the key bonus must not fire on bare interrogatives, or the "사이트
      // 조작법" chunk wins every question that contains "어떻게"
      if ((c.keys || []).some((k) => !STOPKEYS.has(k) && ql.includes(k.toLowerCase()))) s += 4;
      if (s > 1) hits.push({ kind: 'chunk', score: s, face: c.face, ref: c });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  function askCogspect(q) {
    if (chatAbort) chatAbort.abort();
    const hits = retrieve(q);
    if (!hits.length) {
      showGhost('그 질문에 답할 지식이 아직 없어요. 프로젝트, 디자인 철학, 사이트 구성에 대해 물어보세요.');
      return;
    }
    const top = hits[0];
    const projHits = hits.filter((h) => h.kind === 'project').slice(0, 3);
    const face = top.face || (projHits.length ? 'right' : null);
    if (face && face !== cur) navigateTo(face);
    if (projHits.length) markProjects(projHits.map((h) => h.ref.id));
    showGhost('생각을 모으는 중…', true);
    const context = hits.slice(0, 3).map((h) => h.kind === 'project'
      ? `- ${h.ref.title} (${h.ref.tag}): ${h.ref.tagline}. ${h.ref.desc}`
        + ` 사용 기술: ${stackText(h.ref.stack)}.`
        + ` 주요 성과: ${(h.ref.sections || []).map((s) => s.heading).join(' / ')}`
      : `- ${h.ref.title}: ${h.ref.text}`).join('\n');
    const fallback = projHits.length
      ? `관련 프로젝트: ${projHits.map((h) => `${h.ref.title} — ${h.ref.tagline}`).join(' · ')}`
      : (top.ref.text || top.ref.desc || '');
    const ctl = new AbortController();
    chatAbort = ctl;
    chatForm.classList.add('thinking');     // quiet sweep while the model works
    const abortTimer = setTimeout(() => ctl.abort(), 25000);
    const token = localStorage.getItem('cogspect.chat.token') || '';
    fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Cogspect-Key': token } : {})
      },
      signal: ctl.signal,
      body: JSON.stringify({
        system: SYSTEM_PROMPT,
        prompt: `[컨텍스트]\n${context}\n\n[질문]\n${q}`,
        max_tokens: 200,
        temperature: 0.3
      })
    })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => { if (ctl === chatAbort) showGhost((d.reply || '').trim() || fallback); })
      .catch(() => { if (ctl === chatAbort) showGhost(fallback); })
      .finally(() => {
        clearTimeout(abortTimer);
        if (ctl === chatAbort) chatForm.classList.remove('thinking');
      });
  }

  function isQuestion(q) {
    return /[?？]|뭐|무엇|어떤|어떻게|있어|있나|어때|누구|왜|설명|알려|소개/.test(q)
      || tokenize(q).length >= 3;
  }

  /* ---------- chat: message → coordinate routing ---------- */

  const ROUTES = [
    { face: 'front',  keys: ['home', 'cogspect', '홈', '처음', '코그스펙트'] },
    { face: 'right',  keys: ['portfolio', 'work', '포트폴리오', '작업', '프로젝트'] },
    { face: 'left',   keys: ['bifrost', 'bifröst', 'gateway', 'b3ta', '비프로스트', '게이트', '베타'] },
    { face: 'back',   keys: ['keen', 'design', '킨', '디자인'] },
    { face: 'top',    keys: ['prospect', 'vision', '프로스펙트', '비전', '전망'] },
    { face: 'bottom', keys: ['minimalid', 'minimal', 'philosophy', 'v0id', 'void', 'archive', '미니멀리드', '아카이브'] }
  ];
  const CONTACT_KEYS = ['contact', 'mail', 'email', '연락', '문의', '메일', '컨택'];

  function showToast(msg) {
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = chatInput.value.trim().toLowerCase();
    if (!q) return;
    chatInput.value = '';
    if (CONTACT_KEYS.some((k) => q.includes(k))) {
      openContact();
      showToast('연결 채널을 열었습니다.');
      return;
    }
    const route = ROUTES.find((r) => r.keys.some((k) => q.includes(k)));
    if (route && !isQuestion(q)) {
      // short navigation command → instant turn, no LLM round-trip
      if (route.face === cur && phase === 'idle') {
        navigateTo(route.face);
        showToast(`이미 ${LABELS[route.face]} 좌표에 있어요.`);
      } else if (navigateTo(route.face)) {
        showToast(`${LABELS[route.face]} 좌표로 이동합니다.`);
      } else {
        showToast('회전 중이에요. 잠시 후 다시 입력해 주세요.');
      }
      return;
    }
    askCogspect(q);
  });

  /* ---------- boot: entrance drift ---------- */

  layout();
  setFace('front');                  // also makes the five hidden faces inert
  window.addEventListener('resize', () => { layout(); buildGrass(); });

  fetch('data/projects.json')
    .then((r) => r.json())
    .then((d) => {
      PROJECTS = d.projects || [];
      grassKey = '';                 // force rebuild even if a resize ran first
      buildGrass();
    })
    .catch((err) => console.warn('projects.json load failed:', err));

  /* The cube is the whole argument for this site, and a still first frame
     cannot make it: before this, a visitor landed on a near-blank page and
     had to guess there was anything to turn. The intro rolls the object
     through one slow tumble — every face passes the camera once — and then
     zooms in and lands square on the front face.

     Like the old entrance drift, it never touches O: the poses are passed
     to paintFaces() directly, so the logical orientation stays exactly ID
     and an arrow key pressed mid-intro still turns from a square pose. */

  /* Nobody arriving here knows what this is. The cube says "spatial toy", not
     "portfolio", so cpt introduces the place once, in its own voice, right
     after the intro lands — late enough that it is not competing with the
     tumble for attention, early enough to catch someone before they leave. */
  const GREETING = '안녕하세요, 저는 cogspect의 안내 에이전트 cpt입니다. '
    + '이곳은 기술과 예술의 접목을 지향하는 cogspect이자, 개발자 김민혁의 포트폴리오입니다. '
    + '작업물은 오른쪽 면에 있어요. 방향키나 드래그로 넘겨 보시고, 궁금한 건 아래에 물어보세요.';

  function greet() {
    if (overlayOpen() || ghost.classList.contains('show')) return;
    showGhost(GREETING);
  }

  const INTRO_LEG = 1080;
  let introTimers = [];
  let introOver = false;

  function endIntro(animate) {
    if (introOver) return;
    introOver = true;
    introTimers.forEach(clearTimeout);
    introTimers = [];
    stage.classList.remove('intro');
    drifting = false;
    rotHold = false;                 // release the zoom clamp — springs in to 1
    phase = 'idle';
    applyCube(animate !== false);
    // a beat after the cube settles, not on top of it
    setTimeout(greet, 900);
  }

  function runIntro() {
    phase = 'intro';                 // pointerdown/step both bail on a non-idle phase
    rotHold = true;                  // holds the cube back at ROT_ZOOM: an object, not a wall
    zoomCur = 0.2;                   // ...and it grows into that on the way in
    stage.classList.add('intro');
    // Two moves, not three: each leg is a separate composited transition over
    // six large faces, and three of them back to back dropped frames on the
    // way in. Still a full -360° about Y, still every face passing the camera
    // once — the intermediate is past 180° on purpose, so slerp's short way
    // home from it continues in the SAME direction instead of unwinding, and
    // the two legs read as one unbroken roll rather than a there-and-back.
    const legs = [
      [mul(rotY(-200), rotX(-18)), INTRO_LEG],
      [ID, INTRO_LEG - 60],
    ];
    paintFaces(false, 0, null, mul(rotY(-14), rotX(8)));
    let at = 240;
    for (const [M, ms] of legs) {
      introTimers.push(setTimeout(() => {
        if (introOver) return;
        paintFaces(true, ms, 'cubic-bezier(.42,0,.3,1)', M);
      }, at));
      at += ms;
    }
    introTimers.push(setTimeout(() => endIntro(false), at + 40));
  }

  // any deliberate input skips it — and because these listeners capture, the
  // same gesture then reaches the normal handlers with phase already 'idle'
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, () => endIntro(true), { capture: true, passive: true });
  }

  if (reducedMotion.matches) {
    introOver = true;
    drifting = false;
    applyCube(false);
    setTimeout(greet, 2000);
  } else {
    runIntro();
  }

  tick();
})();
