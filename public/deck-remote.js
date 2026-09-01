/* --------------------------------------------------------------------
 * Slide remote — presenter half.
 *
 * Adds a "remote" pill to the deck HUD. Pair a phone with the 4-character
 * code and its Next/Prev buttons drive this deck.
 *
 * Two properties this file protects, in priority order:
 *
 * 1. It is ADDITIVE. If the relay is unreachable, the socket dies, or this
 *    script throws, the deck behaves exactly as it did before. Everything
 *    below is wrapped accordingly and nothing here is on the deck's own
 *    navigation path.
 *
 * 2. It knows NOTHING about deck structure. It advances by dispatching the
 *    same arrow keydown a keyboard would, so added, deleted or reordered
 *    fragments need no change here and cannot desync the phone.
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  const WS_PATH = '/rc';
  const STORE_KEY = 'cosc264-remote-code';
  const HIDE_KEY = 'cosc264-hide-remote';
  const CAP_WORDS = 30;     // roughly the three lines the caption box holds
  const RETRY_MIN = 1000;
  const RETRY_MAX = 15000;

  let ws = null;
  let code = null;
  let lastSeq = 0;          // dedupe lives here, not on the server
  let retry = RETRY_MIN;
  let retryTimer = null;
  let wakeLock = null;
  let wantOpen = false;     // has the user actually started a session?
  let capWords = [];        // trailing window of finalised caption words
  let capOn = false;        // has the phone asked for captions?
  let capCount = 0;         // caption messages received, for diagnosis
  let pointOn = false;      // is the phone currently holding the pointer?
  let ptX = 0.5, ptY = 0.5; // cursor, normalised into STAGE space (not viewport)
  let dotX = 0, dotY = 0;   // ...and the viewport pixels that resolves to

  /* ---------- drive the deck ---------- */

  // The decks keep next()/previous() private, but every one of them listens
  // for arrow keys on the window. Synthesising the keypress is the smallest
  // possible coupling: no deck code changes, and it follows the deck's own
  // fragment logic for free.
  function step(dir) {
    const key = dir === 'prev' ? 'ArrowLeft' : 'ArrowRight';
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  /* ---------- screen wake lock ---------- */

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* unsupported or refused; not worth surfacing */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wantOpen) keepAwake();
  });

  /* ---------- UI ---------- */

  const el = (tag, props = {}, style = '') => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    if (style) n.setAttribute('style', style);
    return n;
  };

  const panel = el('div', { id: 'rc-panel' });
  panel.innerHTML = `
    <div id="rc-backdrop"></div>
    <div id="rc-card" role="dialog" aria-modal="true" aria-labelledby="rc-title">
      <button id="rc-close" aria-label="Close">&times;</button>
      <p id="rc-title">Slide remote</p>
      <p class="rc-step">1 &nbsp;Open <b id="rc-url"></b> on your phone</p>
      <p class="rc-step">2 &nbsp;Enter this code</p>
      <div id="rc-code">····</div>
      <p id="rc-status">Connecting…</p>
    </div>`;

  const capBand = el('div', { id: 'rc-cap' });
  capBand.innerHTML =
    '<span id="rc-cap-cc">CC</span>' +
    '<div id="rc-cap-clip"><div id="rc-cap-text">' +
    '<span id="rc-cap-run"><span id="rc-cap-final"></span> <span id="rc-cap-interim"></span></span>' +
    '</div></div>';

  const dot = el('div', { id: 'rc-dot' });

  const pill = el('button', {
    id: 'b-remote',
    className: 'hud-button',
    title: 'Slide remote',
    textContent: '⌁ remote',
  });

  const style = el('style');
  style.textContent = `
    #b-remote.rc-live{color:var(--accent,#0f8f83);border-color:var(--accent,#0f8f83)}
    #rc-panel{display:none}
    #rc-panel.rc-open{display:block}
    #rc-backdrop{position:fixed;inset:0;background:rgba(8,14,18,.55);
      backdrop-filter:blur(3px);z-index:900}
    #rc-card{position:fixed;z-index:901;top:50%;left:50%;transform:translate(-50%,-50%);
      background:var(--surface,#fff);color:var(--ink,#15242f);
      border:1px solid var(--border,var(--line,#d4dde3));border-radius:18px;
      padding:30px 38px 26px;text-align:center;min-width:330px;
      box-shadow:0 24px 60px rgba(8,14,18,.35);
      font-family:var(--sans,system-ui,sans-serif)}
    #rc-close{position:absolute;top:10px;right:14px;border:0;background:none;
      font-size:26px;line-height:1;color:var(--faint,#84939d);cursor:pointer}
    #rc-title{margin:0 0 18px;font-family:var(--serif,Georgia,serif);
      font-size:22px;font-weight:600}
    .rc-step{margin:0 0 8px;font-size:15px;color:var(--muted,#54646f);text-align:left}
    #rc-url{font-family:var(--mono,monospace);color:var(--accent,#0f8f83)}
    #rc-code{font-family:var(--mono,monospace);font-size:52px;font-weight:700;
      letter-spacing:.18em;color:var(--accent,#0f8f83);margin:10px 0 14px;
      text-indent:.18em}
    #rc-status{margin:0;font-size:14px;color:var(--faint,#84939d)}
    /* Captions, in the shape a video player uses: a block that floats over
       the slide rather than a bar bolted to the bottom of it, with the dark
       ground painted only behind the words. Nothing is drawn when there is
       nothing to say. */
    #rc-cap{position:fixed;left:0;right:0;bottom:0;z-index:800;display:none;
      pointer-events:none;color:#fff;text-align:center;
      font-family:var(--sans,system-ui,sans-serif);
      font-size:30px;line-height:1.42;
      padding-bottom:calc(10px + env(safe-area-inset-bottom))}
    /* Three lines, and the text is pinned to the BOTTOM of the window so
       anything over-long spills off the top and the newest words stay on
       screen -- the opposite of normal overflow, and the only behaviour
       that makes sense for live speech. */
    #rc-cap-clip{height:4.26em;overflow:hidden;position:relative;
      width:min(1100px,82vw);margin:0 auto}
    #rc-cap-text{position:absolute;left:0;right:0;bottom:0}
    #rc-cap.on{display:block}
    /* box-decoration-break gives every wrapped line its own background box,
       so the ground hugs the text the way a caption should instead of
       squaring off a paragraph-sized slab. The block sits hard against the
       bottom of the window: floated any higher it lands on whatever the
       slide has down there. */
    #rc-cap-run{background:rgba(8,14,18,.76);
      -webkit-box-decoration-break:clone;box-decoration-break:clone;
      padding:.1em .34em}
    #rc-cap-interim{color:#c3d2d9}
    #rc-cap-cc{position:fixed;left:14px;bottom:12px;font-family:var(--mono,monospace);
      font-size:11px;letter-spacing:.14em;color:#5f7681;border:1px solid #35505c;
      border-radius:4px;padding:1px 5px}
    /* the deck's own footer furniture would sit underneath the band */
    body.rc-captioning #counter,body.rc-captioning #seclabel,
    body.rc-captioning #section-label{display:none}
    /* Pointer. Only ever moved via transform: a fixed element translated on
       the compositor costs no layout and no repaint, which is what lets this
       run at 40Hz over a 1280x720 stage without touching the slide. */
    /* Shown by toggling display, NOT by transitioning opacity. A transition
       has to be *started* by the compositor, and a tab that was backgrounded
       or a display that just woke can leave one committed at its from-value
       indefinitely -- observed here as a cursor stuck at opacity 0 with the
       .on class correctly applied. A pointer that silently fails to appear in
       front of a lecture theatre is not worth a 160ms fade. */
    #rc-dot{position:fixed;z-index:850;left:0;top:0;width:26px;height:26px;
      margin:-13px 0 0 -13px;border-radius:50%;pointer-events:none;display:none;
      background:radial-gradient(circle at 50% 40%,#ff6b5e 0%,#e0322a 55%,rgba(150,16,10,.55) 100%);
      box-shadow:0 0 16px 5px rgba(255,60,45,.4);will-change:transform}
    #rc-dot.on{display:block}
    /* Expanding rings rather than a blink: at eight metres a blinking mark is
       hard to *locate*, whereas an expanding one drags the eye inward to its
       own centre. Two rings, staggered, read as deliberate; one reads as a
       rendering glitch. */
    .rc-ping{position:fixed;z-index:849;width:26px;height:26px;margin:-13px 0 0 -13px;
      border-radius:50%;pointer-events:none;border:3px solid rgba(255,74,58,.9);
      animation:rc-ping-out .9s cubic-bezier(.2,.6,.3,1) forwards}
    @keyframes rc-ping-out{from{transform:scale(1);opacity:.95}
      to{transform:scale(9);opacity:0}}
    @media (max-width:600px){#rc-card{min-width:0;width:86vw;padding:26px 22px 22px}
      #rc-code{font-size:42px}}`;

  function setCap(final, interim) {
    const f = document.getElementById('rc-cap-final');
    const i = document.getElementById('rc-cap-interim');
    if (f) f.textContent = final;
    if (i) i.textContent = interim;
    // the run carries a literal word space between the two, so with nothing
    // said yet it would still paint a thin dark sliver over the slide
    const run = document.getElementById('rc-cap-run');
    if (run) run.style.visibility = (final || interim) ? '' : 'hidden';
  }

  /* ---------- pointer ----------
   *
   * Coordinates arrive normalised into the 1280x720 stage, never in pixels.
   * The stage is centred and scaled to whatever window it lands in, so a
   * pixel from the presenter's laptop would miss by a long way on a projector
   * of a different aspect. getBoundingClientRect absorbs that scale for free.
   */
  function stageRect() {
    const st = document.getElementById('stage');
    const r = st && st.getBoundingClientRect();
    // A deck with no stage, or one in scroll/print mode where the stage has
    // been unpinned, still gets a usable pointer over the viewport.
    if (!r || !r.width || !r.height) {
      return { left: 0, top: 0, width: innerWidth, height: innerHeight };
    }
    return r;
  }

  function placeDot() {
    const r = stageRect();
    dotX = r.left + ptX * r.width;
    dotY = r.top + ptY * r.height;
    dot.style.transform = `translate3d(${dotX}px,${dotY}px,0)`;
  }

  function ping() {
    if (!pointOn) return;                 // no cursor on screen to ping at
    for (const delay of [0, 140]) {
      setTimeout(() => {
        const ring = el('div', { className: 'rc-ping' });
        ring.style.left = `${dotX}px`;
        ring.style.top = `${dotY}px`;
        document.body.appendChild(ring);
        setTimeout(() => ring.remove(), 1000);
      }, delay);
    }
  }

  // Resizing or fullscreening mid-lecture rescales the stage under a cursor
  // whose normalised position has not changed.
  addEventListener('resize', () => { if (pointOn) placeDot(); });

  function showPointer(on) {
    pointOn = on;
    dot.classList.toggle('on', on);
    if (on) placeDot();
  }

  function statusLine() {
    if (!capOn) return 'Phone connected.';
    return capCount
      ? `Phone connected · captions on · ${capCount} received`
      : 'Phone connected · captions on · nothing heard yet';
  }

  function paint(text, live) {
    const s = document.getElementById('rc-status');
    if (s) s.textContent = text;
    pill.classList.toggle('rc-live', !!live);
  }

  function openPanel() {
    panel.classList.add('rc-open');
    wantOpen = true;
    keepAwake();
    connect();
  }
  function closePanel() { panel.classList.remove('rc-open'); }

  /* ---------- transport ---------- */

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    let sock;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      sock = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    } catch {
      paint('Could not connect. The deck still works normally.', false);
      return;
    }
    ws = sock;

    sock.addEventListener('open', () => {
      retry = RETRY_MIN;
      sock.send(JSON.stringify({ role: 'presenter', code }));
    });

    sock.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }

      if (m.type === 'ready') {
        code = m.code;
        try { sessionStorage.setItem(STORE_KEY, code); } catch {}
        const c = document.getElementById('rc-code');
        if (c) c.textContent = code;
        if (m.remotes) lastSeq = 0;
        paint(m.remotes ? 'Phone connected.' : 'Waiting for your phone…', m.remotes > 0);
        return;
      }

      if (m.type === 'remote') {
        // A phone that has just (re)joined starts counting from scratch, so a
        // stale high-water mark here would silently swallow every tap. Each
        // pairing therefore begins a fresh command stream. The guard still
        // does its real job -- rejecting duplicates *within* a stream.
        if (m.connected) lastSeq = 0;
        // A phone that walks away mid-point would otherwise leave its cursor
        // stranded on the projector with nothing able to clear it.
        if (!m.connected) showPointer(false);
        paint(m.connected ? statusLine() : 'Waiting for your phone…', m.connected);
        // Hide the code once paired: it is on a projector in front of a class.
        if (m.connected) setTimeout(closePanel, 900);
        return;
      }

      if (m.type === 'captions') {
        capOn = m.on;
        capBand.classList.toggle('on', m.on);
        document.body.classList.toggle('rc-captioning', m.on);
        if (m.on) {
          // Show something immediately. Otherwise "captions on but nothing
          // heard yet" and "captions never switched on" look identical, and
          // there is no way to tell which is broken.
          if (!capWords.length) setCap('', 'listening…');
        } else {
          capWords = []; capCount = 0; setCap('', '');
        }
        paint(statusLine(), true);
        return;
      }

      if (m.type === 'caption') {
        // Corrected here rather than on the phone: this is the machine doing
        // the projecting, so it guarantees what goes on screen regardless of
        // what reached it, and the table can be updated without the phone
        // reloading anything.
        capCount++;
        const text = window.fixCaption ? window.fixCaption(String(m.text)) : String(m.text);
        if (m.final) {
          capWords = capWords.concat(text.split(/\s+/).filter(Boolean));
          if (capWords.length > CAP_WORDS) capWords = capWords.slice(-CAP_WORDS);
          setCap(capWords.join(' '), '');
        } else {
          // iOS can hold a very long interim result before finalising it, so
          // the two have to share one budget. Trimming only the final text
          // let the interim grow without limit and swallow the slide.
          // The budget is tight on one line, so this matters more than it did.
          const iw = text.split(/\s+/).filter(Boolean);
          const room = Math.max(0, CAP_WORDS - iw.length);
          // slice(-0) is slice(0), which returns the whole array rather
          // than none, so the zero case has to be handled explicitly.
          setCap(room ? capWords.slice(-room).join(' ') : '', iw.slice(-CAP_WORDS).join(' '));
        }
        return;
      }

      if (m.type === 'point') { showPointer(!!m.on); return; }

      if (m.type === 'move') {
        // Clamped rather than dropped: a cursor pinned to the edge tells the
        // presenter which way they have over-tilted, an absent one does not.
        ptX = Math.min(1, Math.max(0, Number(m.x) || 0));
        ptY = Math.min(1, Math.max(0, Number(m.y) || 0));
        placeDot();
        return;
      }

      if (m.type === 'ping') { ping(); return; }

      if (m.type === 'cmd') {
        // Absolute sequence guard: a duplicated or delayed tap cannot
        // advance the deck twice.
        if (typeof m.seq !== 'number' || m.seq <= lastSeq) return;
        lastSeq = m.seq;
        step(m.cmd);
      }
    });

    const retryLater = () => {
      ws = null;
      showPointer(false);           // same reason: never strand a cursor
      if (!wantOpen) return;
      paint('Reconnecting…', false);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, RETRY_MAX);
    };
    sock.addEventListener('close', retryLater);
    sock.addEventListener('error', () => { try { sock.close(); } catch {} });
  }

  /* ---------- mount ---------- */

  /* ---------- who sees the remote ----------
   *
   * Shown by default. Gating it behind an opt-in flag meant that any device
   * which lost its localStorage -- Private Browsing, cleared storage, a
   * different browser -- silently got no remote and no captions at all, with
   * nothing on screen to say why. A visible control that students ignore is
   * better than an invisible one that strands the presenter.
   *
   * Students seeing it costs nothing: pressing it opens a session for their
   * own screen only. Driving a deck needs that deck's 4-character code.
   *
   *   ?present=0  hide it on this device (remembered)
   *   ?present    show it again
   */
  function remoteVisible() {
    let q;
    try { q = new URLSearchParams(location.search); } catch { return true; }
    if (q.has('present')) {
      const show = q.get('present') !== '0';
      try {
        show ? localStorage.removeItem(HIDE_KEY) : localStorage.setItem(HIDE_KEY, '1');
      } catch {}
      return show;
    }
    try { return localStorage.getItem(HIDE_KEY) !== '1'; } catch { return true; }
  }

  function mount() {
    if (!remoteVisible()) return;           // explicitly hidden on this device
    const hud = document.getElementById('hud');
    if (!hud) return;                       // unknown deck shell: do nothing
    document.head.appendChild(style);
    document.body.appendChild(panel);
    document.body.appendChild(capBand);
    document.body.appendChild(dot);
    hud.appendChild(pill);

    const url = document.getElementById('rc-url');
    if (url) url.textContent = `${location.host}/remote/`;

    pill.addEventListener('click', openPanel);
    document.getElementById('rc-close').addEventListener('click', closePanel);
    document.getElementById('rc-backdrop').addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('rc-open')) closePanel();
    });

    try { code = sessionStorage.getItem(STORE_KEY); } catch {}
  }

  // Never let this file break a lecture.
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { try { mount(); } catch {} });
    } else {
      mount();
    }
  } catch { /* deck continues unaffected */ }
})();
