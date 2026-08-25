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
  const PRESENT_KEY = 'cosc264-presenter';
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
    '<span id="rc-cap-final"></span> <span id="rc-cap-interim"></span>';

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
    /* Caption band. Sized for the back of a lecture theatre and painted on
       its own dark ground so it stays legible over any slide, in either
       deck theme. Two lines maximum; older text is trimmed away in JS
       rather than scrolled, so the newest words are always the visible ones. */
    #rc-cap{position:fixed;left:0;right:0;bottom:0;z-index:800;display:none;
      background:rgba(8,14,18,.9);color:#fff;text-align:center;
      font-family:var(--sans,system-ui,sans-serif);
      font-size:clamp(21px,2.5vw,33px);line-height:1.34;
      padding:16px 5vw;padding-bottom:calc(16px + env(safe-area-inset-bottom));
      text-wrap:balance}
    #rc-cap.on{display:block}
    #rc-cap-interim{color:#9fb4bd}
    #rc-cap-cc{position:absolute;left:14px;top:10px;font-family:var(--mono,monospace);
      font-size:11px;letter-spacing:.14em;color:#5f7681;border:1px solid #35505c;
      border-radius:4px;padding:1px 5px}
    /* the deck's own footer furniture would sit underneath the band */
    body.rc-captioning #counter,body.rc-captioning #seclabel,
    body.rc-captioning #section-label{display:none}
    @media (max-width:600px){#rc-card{min-width:0;width:86vw;padding:26px 22px 22px}
      #rc-code{font-size:42px}}`;

  function setCap(final, interim) {
    const f = document.getElementById('rc-cap-final');
    const i = document.getElementById('rc-cap-interim');
    if (f) f.textContent = final;
    if (i) i.textContent = interim;
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
          // Keep only what can fit two lines; the newest words are the
          // point, and an unbounded string would grow all lecture.
          if (capWords.length > 26) capWords = capWords.slice(-26);
          setCap(capWords.join(' '), '');
        } else {
          setCap(capWords.join(' '), text);
        }
        return;
      }

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

  /* ---------- presenter mode ----------
   *
   * Students should never see the remote control: it is clutter on a page
   * they are reading, and an invitation to poke at something irrelevant to
   * them. So the pill only exists on a device that has opted in.
   *
   * This is NOT a security boundary and is not meant to be one. A student
   * who found the flag could only ever open a session for their own screen,
   * because driving a deck requires that deck's own 4-character code. The
   * code is the protection; this is just tidiness.
   *
   *   ?present    turn this device into a presenter (remembered afterwards)
   *   ?present=0  turn it back off
   */
  function presenterMode() {
    let q;
    try { q = new URLSearchParams(location.search); } catch { return false; }
    if (q.has('present')) {
      const on = q.get('present') !== '0';
      // Remembered per-device and per-origin, so you set it once on the iPad
      // and every week's deck has it from then on.
      try { on ? localStorage.setItem(PRESENT_KEY, '1') : localStorage.removeItem(PRESENT_KEY); } catch {}
      return on;
    }
    try { return localStorage.getItem(PRESENT_KEY) === '1'; } catch { return false; }
  }

  function mount() {
    if (!presenterMode()) return;           // student device: no pill, no socket
    const hud = document.getElementById('hud');
    if (!hud) return;                       // unknown deck shell: do nothing
    document.head.appendChild(style);
    document.body.appendChild(panel);
    document.body.appendChild(capBand);
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
