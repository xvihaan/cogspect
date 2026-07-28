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

  // Every face is always mounted upright in its slot; only the cube's slot
  // assignment changes, so no content is ever rolled or mirrored.
  const NAV = {
    front:  { right: 'right', left: 'left',  up: 'top',    down: 'bottom', back: 'back' },
    right:  { right: 'back',  left: 'front', up: 'top',    down: 'bottom', back: 'left' },
    back:   { right: 'left',  left: 'right', up: 'top',    down: 'bottom', back: 'front' },
    left:   { right: 'front', left: 'back',  up: 'top',    down: 'bottom', back: 'right' },
    top:    { right: 'right', left: 'left',  up: 'back',   down: 'front',  back: 'bottom' },
    bottom: { right: 'right', left: 'left',  up: 'front',  down: 'back',   back: 'top' }
  };
  const SLOT = {
    front: 'rotateY(0deg)', right: 'rotateY(90deg)', left: 'rotateY(-90deg)',
    back: 'rotateY(180deg)', top: 'rotateX(90deg)', bottom: 'rotateX(-90deg)'
  };
  // outward normals of each slot (CSS coords: x right, y down, z toward viewer)
  const SLOT_NORMALS = {
    front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0],
    left: [-1, 0, 0], top: [0, -1, 0], bottom: [0, 1, 0]
  };
  // cube orientation (rx, ry) that fronts each slot with upright content
  const CANON = {
    front: [0, 0], right: [0, -90], left: [0, 90],
    back: [0, 180], top: [-90, 0], bottom: [90, 0]
  };
  const LABELS = {
    front: '01 · canvas', right: '02 · portfolio', left: '03 · gateway',
    back: '04 · keen', top: '05 · vision', bottom: '06 · v0id'
  };

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
  let rx = 0, ry = 0;               // free-roll orientation (deg)
  let vx = 0, vy = 0;               // roll velocity (deg per 60Hz frame)
  let drag = null;
  let slotToFace = {};
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

  // Clean white canvas by default: the tile texture (.grass-veil) is only
  // revealed around the cursor via a CSS mask; six always-visible silver
  // pixels are placed at viewport-relative fractions.
  const grassVeil = document.getElementById('grassVeil');
  let grassKey = '';
  let projTiles = [];
  let tileTones = null;

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
    grass.querySelectorAll('.cell--proj').forEach((c) => c.remove());
    projTiles = [];
    PROJECTS.forEach((p, i) => {
      // fx/fy are fractions of the VISIBLE viewport, remapped into the S×S
      // face so tiles stay on-screen in both orientations
      const gx = 0.5 + (p.fx - 0.5) * (W / w);
      const gy = 0.5 + (p.fy - 0.5) * (H / w);
      const t = document.createElement('div');
      t.className = 'cell--proj';
      t.dataset.project = p.id;
      t.dataset.tone = tileTones[i];
      t.setAttribute('role', 'button');
      t.setAttribute('tabindex', '0');
      t.setAttribute('aria-label', `${p.title} — ${p.tagline}`);
      t.style.left = `${(gx * 100).toFixed(3)}%`;
      t.style.top = `${(gy * 100).toFixed(3)}%`;
      grass.appendChild(t);
      projTiles.push({ el: t, gx, gy });
    });
  }

  function projectOf(el) {
    const cell = el.closest && el.closest('.cell--proj');
    return cell ? PROJECTS.find((p) => p.id === cell.dataset.project) : null;
  }

  function showTip(cell, p) {
    tileTip.innerHTML = `<strong>${p.title}</strong><span>${p.tagline} · 클릭해서 자세히</span>`;
    const half = 120;
    const x = Math.max(half, Math.min(grass.clientWidth - half, cell.offsetLeft + cell.offsetWidth / 2));
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
    projStack.innerHTML = (p.stack || []).map((s) => `<span>${s}</span>`).join('');
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
    projOverlay.querySelector('.project-card').scrollTop = 0;
    haptic();
    pixelBurst();
  }

  // pixel-materialize: tiny glass squares sparkle across the card as it opens
  function pixelBurst() {
    if (reducedMotion.matches) return;
    const card = projOverlay.querySelector('.project-card');
    const old = card.querySelector('.pix-burst');
    if (old) old.remove();
    const burst = document.createElement('div');
    burst.className = 'pix-burst';
    for (let i = 0; i < 46; i++) {
      const s = document.createElement('i');
      const size = 5 + Math.random() * 9;
      s.style.cssText =
        `left:${(Math.random() * 96).toFixed(1)}%;top:${(Math.random() * 96).toFixed(1)}%;` +
        `width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;` +
        `animation-delay:${(Math.random() * 240).toFixed(0)}ms`;
      burst.appendChild(s);
    }
    card.appendChild(burst);
    setTimeout(() => burst.remove(), 950);
  }
  function closeProject() {
    projOverlay.classList.remove('open');
    projOverlay.setAttribute('aria-hidden', 'true');
    projOverlay.inert = true;
  }
  function projectOpen() {
    return projOverlay.classList.contains('open');
  }

  projOverlay.addEventListener('click', (e) => {
    if (e.target === projOverlay) closeProject();
  });
  document.getElementById('projectClose').addEventListener('click', closeProject);

  /* ---------- cube geometry ---------- */

  function assignSlots() {
    const nav = NAV[cur];
    const slotOf = {
      [cur]: 'front', [nav.right]: 'right', [nav.left]: 'left',
      [nav.up]: 'top', [nav.down]: 'bottom', [nav.back]: 'back'
    };
    slotToFace = {};
    cube.querySelectorAll('[data-face]').forEach((f) => {
      const slot = slotOf[f.dataset.face] || 'back';
      slotToFace[slot] = f.dataset.face;
      f.style.transform = `${SLOT[slot]} translateZ(${D}px)`;
    });
  }

  function rotFor(dir, p) {
    const a = 90 * (p === undefined ? 1 : p);
    if (dir === 'right') return `rotateY(${-a}deg)`;
    if (dir === 'left') return `rotateY(${a}deg)`;
    if (dir === 'up') return `rotateX(${-a}deg)`;
    return `rotateX(${a}deg)`;
  }

  function applyCube(animate, rot, ms) {
    cube.style.transition = animate ? `transform ${ms || ROT_MS}ms ${EASE_TURN}` : 'none';
    cube.style.transform = `translateZ(${-D}px)${rot ? ' ' + rot : ''}`;
  }

  function applyFree() {
    cube.style.transition = 'none';
    cube.style.transform = `translateZ(${-D}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  }

  function layout() {
    const W = window.innerWidth, H = window.innerHeight, S = Math.max(W, H);
    D = S / 2;
    cube.style.width = `${S}px`;
    cube.style.height = `${S}px`;
    cube.style.left = `${(W - S) / 2}px`;
    cube.style.top = `${(H - S) / 2}px`;
    assignSlots();
    if (phase === 'drag' || phase === 'roll') applyFree();
    else applyCube(false);
  }

  function setFace(face) {
    cur = face;
    indicator.textContent = LABELS[face];
    document.body.classList.toggle('on-dark', face === 'bottom');
  }

  /* ---------- free roll: nearest-face detection & snap ---------- */

  // Which slot faces the viewer for cube transform rotateX(rx) rotateY(ry)?
  // CSS applies M = Rx·Ry to cube-local vectors; pick the slot normal with
  // the largest resulting z (toward the viewer).
  function frontSlotFor(rxDeg, ryDeg) {
    const ax = rxDeg * Math.PI / 180, ay = ryDeg * Math.PI / 180;
    const cx = Math.cos(ax), sx = Math.sin(ax);
    const cy = Math.cos(ay), sy = Math.sin(ay);
    let best = 'front', bz = -2;
    for (const s in SLOT_NORMALS) {
      const [x, y, z] = SLOT_NORMALS[s];
      const y1 = y;
      const z1 = -sy * x + cy * z;
      const z2 = sx * y1 + cx * z1;
      if (z2 > bz) { bz = z2; best = s; }
    }
    return best;
  }

  function landThunk() {
    if (!reducedMotion.matches) kick = KICK;
    haptic();
  }

  function finalizeOrientation(slot) {
    setFace(slotToFace[slot] || cur);
    assignSlots();
    rx = 0; ry = 0; vx = 0; vy = 0;
    applyCube(false);
    rotHold = false;
    phase = 'idle';
    landThunk();
  }

  // Roll to rest: unwind to the nearest slot's canonical (upright-content)
  // orientation, then re-anchor the slot assignment and reset to identity.
  function beginSnap() {
    if (phase !== 'drag' && phase !== 'roll') return;
    phase = 'snap';
    clearTimeout(snapTimer);
    const slot = frontSlotFor(rx, ry);
    const [bx, by] = CANON[slot];
    const rxT = bx + 360 * Math.round((rx - bx) / 360);
    const ryT = by + 360 * Math.round((ry - by) / 360);
    const dist = Math.max(Math.abs(rxT - rx), Math.abs(ryT - ry));
    rx = rxT; ry = ryT;
    if (dist < 0.5 || reducedMotion.matches) { finalizeOrientation(slot); return; }
    const ms = Math.max(280, Math.min(780, dist * 8));
    cube.style.transition = `transform ${ms}ms ${EASE_SNAP}`;
    cube.style.transform = `translateZ(${-D}px) rotateX(${rxT}deg) rotateY(${ryT}deg)`;
    snapTimer = setTimeout(() => finalizeOrientation(slot), ms + 40);
  }

  /* ---------- quarter-turn navigation (arrows / chat) ---------- */

  function commit(dir) {
    clearTimeout(settleTimer);
    clearTimeout(pulseTimer);
    phase = 'turn';
    rotHold = true;
    haptic();
    applyCube(true, rotFor(dir, 1));
    const next = NAV[cur][dir];
    settleTimer = setTimeout(() => {
      setFace(next);
      assignSlots();
      applyCube(false);
      rotHold = false;
      phase = 'idle';
      landThunk();
    }, SETTLE_MS);
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
    const nav = NAV[cur];
    const dir = ['right', 'left', 'up', 'down'].find((d) => nav[d] === face);
    if (dir) { step(dir); return true; }
    // opposite face — two quarter turns along whichever axis reaches it
    const d2 = ['right', 'left', 'up', 'down'].find((d) => NAV[nav[d]][d] === face);
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
    rx = 0; ry = 0; vx = 0; vy = 0;
    setFace('front');
    assignSlots();
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
  }
  function closeContact() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.inert = true;
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

  /* ---------- drag: free tumbling ---------- */

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, a, textarea, form, .cell--proj, .ghost-msg')) return;
    if (overlayOpen()) return;
    if (phase !== 'idle' && phase !== 'roll') return;   // can catch a rolling cube
    clearTimeout(chainTimer);
    clearTimeout(pulseTimer);
    phase = 'drag';
    vx = 0; vy = 0;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false, acc: 0 };
    stage.classList.add('dragging');
    haptic(140);
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved) {
      drag.acc += Math.hypot(dx, dy);
      if (drag.acc > 6) {
        drag.moved = true;
        rotHold = true;
        dismissHint();
      } else return;
    }
    const k = 90 / (Math.min(window.innerWidth, window.innerHeight) * 0.45);
    ry -= dx * k;
    rx += dy * k;
    const now = performance.now();
    const dt = Math.max(8, now - drag.t);
    drag.t = now;
    const f = 16 / dt;                       // normalise to deg per 60Hz frame
    vx = vx * 0.6 + (dy * k * f) * 0.4;
    vy = vy * 0.6 + (-dx * k * f) * 0.4;
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
    if (phase !== 'drag') return;
    if (!d.moved) {
      if (Math.abs(rx) < 0.5 && Math.abs(ry) < 0.5) {
        phase = 'idle';
        rotHold = false;
        if (!cancelled) {
          const dir = emptySpaceDir(d.x, d.y);
          if (dir) step(dir);
        }
      } else {
        beginSnap();                 // caught a rolling cube, released in place
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
    if (e.target.closest && e.target.closest('button, input, a, textarea, .project-card')) return;
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
      if (now - ripples[i].t0 >= 1500) ripples.splice(i, 1);
    }
    if (!ripples.length) return;
    const P = 12, R = 140;
    for (const r of ripples) {
      const age = (now - r.t0) / 1000;
      const front = age * 190, decay = Math.exp(-age * 2.2);
      if (decay < 0.02) continue;
      const x0 = Math.max(0, Math.floor((r.x - R) / P) * P), x1 = Math.min(W, r.x + R);
      const y0 = Math.max(0, Math.floor((r.y - R) / P) * P), y1 = Math.min(H, r.y + R);
      for (let gx = x0; gx < x1; gx += P) {
        for (let gy = y0; gy < y1; gy += P) {
          const dx = gx - r.x, dy = gy - r.y;
          const d = Math.hypot(dx, dy);
          if (d > R) continue;
          const band = d - front;
          const w = Math.exp(-(band * band) / 900) * decay;
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

  /* ---------- render loop: momentum + zoom spring + ripples ---------- */

  let lastTick = performance.now();

  function tick() {
    const now = performance.now();
    const f = Math.min(3, (now - lastTick) / 16.7);   // frames elapsed @60Hz
    lastTick = now;

    if (phase === 'roll') {
      rx += vx * f;
      ry += vy * f;
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

  function dismissGhost() {
    clearTimeout(ghostTimer);
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
      ghostTimer = setTimeout(dismissGhost, dur);
    }
  }
  ghost.addEventListener('click', dismissGhost);

  function tokenize(s) {
    return s.toLowerCase().split(/[^0-9a-z가-힣]+/).filter((t) => t.length > 1);
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
      const hay = [p.title, p.tag, p.tagline, p.desc, (p.points || []).join(' '), (p.stack || []).join(' ')]
        .join(' ').toLowerCase();
      const s = scoreText(hay);
      if (s > 1) hits.push({ kind: 'project', score: s, face: 'right', ref: p });
    }
    for (const c of KNOWLEDGE) {
      const hay = [c.title, c.text, (c.keys || []).join(' ')].join(' ').toLowerCase();
      let s = scoreText(hay);
      if ((c.keys || []).some((k) => ql.includes(k.toLowerCase()))) s += 4;
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
      : `- ${h.ref.title}: ${h.ref.text}`).join('\n');
    const fallback = projHits.length
      ? `관련 프로젝트: ${projHits.map((h) => `${h.ref.title} — ${h.ref.tagline}`).join(' · ')}`
      : (top.ref.text || top.ref.desc || '');
    const ctl = new AbortController();
    chatAbort = ctl;
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
      .finally(() => clearTimeout(abortTimer));
  }

  function isQuestion(q) {
    return /[?？]|뭐|무엇|어떤|어떻게|있어|있나|어때|누구|왜|설명|알려|소개/.test(q)
      || tokenize(q).length >= 3;
  }

  /* ---------- chat: message → coordinate routing ---------- */

  const ROUTES = [
    { face: 'front',  keys: ['home', 'canvas', '홈', '캔버스', '처음'] },
    { face: 'right',  keys: ['matrix', 'portfolio', 'work', '매트릭스', '포트폴리오', '작업'] },
    { face: 'left',   keys: ['gateway', 'gate', 'b3ta', '게이트', '베타'] },
    { face: 'back',   keys: ['keen', 'design', '킨', '디자인'] },
    { face: 'top',    keys: ['vision', '비전'] },
    { face: 'bottom', keys: ['v0id', 'void', 'archive', '보이드', '아카이브'] }
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
  window.addEventListener('resize', () => { layout(); buildGrass(); });

  fetch('data/projects.json')
    .then((r) => r.json())
    .then((d) => {
      PROJECTS = d.projects || [];
      grassKey = '';                 // force rebuild even if a resize ran first
      buildGrass();
    })
    .catch((err) => console.warn('projects.json load failed:', err));

  applyCube(false, 'rotateY(-16deg) rotateX(9deg)');
  setTimeout(() => applyCube(true), 180);
  tick();
})();
