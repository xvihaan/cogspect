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
    front: '01 · canvas', right: '02 · matrix', left: '03 · gateway',
    back: '04 · keen', top: '05 · vision', bottom: '06 · v0id'
  };

  const WORKS = [
    { index: '01', tag: 'Design Language', title: 'keen',             desc: '리퀴드 글래스 기반의 시그니처 인터페이스 언어.' },
    { index: '02', tag: 'Spatial UI',      title: 'Spatial UI Lab',   desc: 'visionOS 스타일 공간 윈도잉과 4D 트랜지션 실험실.' },
    { index: '03', tag: 'AI Research',     title: 'Cognitive Agents', desc: 'AI 에이전트 구조와 인지 파이프라인 설계 연구.' },
    { index: '04', tag: 'Worldbuilding',   title: 'b3ta Engine',      desc: 'b3ta 세계관을 구동하는 내러티브·비주얼 시스템.' },
    { index: '05', tag: 'Archive',         title: 'v0id Archive',     desc: '실험, 프로토타입, 폐기된 차원들의 기록 보관소.' },
    { index: '06', tag: 'Gen AI',          title: 'Prompt Systems',   desc: '생성형 AI 프롬프트 아키텍처와 설계 자산.' }
  ];

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

  /* ---------- portfolio cards ---------- */

  document.getElementById('worksGrid').innerHTML = WORKS.map((w) => `
    <div class="work-card">
      <div class="row"><span class="index">${w.index}</span><span class="tag">${w.tag}</span></div>
      <div><h3>${w.title}</h3><p>${w.desc}</p></div>
    </div>`).join('');

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
    haptic();
    pulseZoom();
    phase = 'turn';
    settleTimer = setTimeout(() => { phase = 'idle'; }, SETTLE_MS);
  }

  /* ---------- contact overlay ---------- */

  function contactOpen() {
    return overlay.classList.contains('open');
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
    if (e.target.closest('button, input, a, textarea, form')) return;
    if (contactOpen()) return;
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
    if (e.target.closest && e.target.closest('button, input, a, textarea')) return;
    e.preventDefault();
    if (contactOpen()) return;
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
    if (e.key === 'Escape') { closeContact(); chatInput.blur(); return; }
    if (document.activeElement === chatInput) return;
    if (drag || contactOpen()) return;
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
    if (route) {
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
    showToast('좌표를 인식하지 못했어요. matrix · gateway · keen · vision · v0id · contact 를 입력해 보세요.');
  });

  /* ---------- boot: entrance drift ---------- */

  layout();
  window.addEventListener('resize', layout);

  applyCube(false, 'rotateY(-16deg) rotateX(9deg)');
  setTimeout(() => applyCube(true), 180);
  tick();
})();
