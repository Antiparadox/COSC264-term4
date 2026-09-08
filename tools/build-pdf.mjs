/**
 * Build printable PDFs from the decks.
 *
 * The decks are the source of truth; these PDFs are derived artefacts. Run
 * `npm run pdf` after changing a deck and commit the result alongside it.
 *
 *   node tools/build-pdf.mjs            # every module
 *   node tools/build-pdf.mjs week10     # just these
 *
 * Each deck is driven with real arrow keys, exactly as it is presented, and
 * snapshotted at every beat. That matters because the decks are not uniform:
 * Module 1 recomputes 25 slides from JS on each step, Module 2 drives content
 * off a data-step attribute, Module 3 updates through a MutationObserver, and
 * Module 5 runs a different engine entirely (data-step + .visible rather than
 * .frag + .on). Toggling classes by hand reproduced none of that; pressing
 * ArrowRight reproduces all of it, because it is the same code path.
 *
 * One page per slide at the deck's own 1280x720 geometry, so the printed
 * layout is the one verified on screen and the text stays selectable. Slides
 * whose beats REPLACE content -- hot-fragment cards, a badge flipping 0 to 1,
 * a table cell being rewritten -- get one page per state, using the fewest
 * pages that still show everything at least once.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PDF_PORT || 4321);
const OUT = path.join(ROOT, 'public', 'pdf');
const MAX_STEPS = 4000;

const MODULES = [
  { dir: 'week7', n: 1 },
  { dir: 'week8', n: 2 },
  { dir: 'week9', n: 3 },
  { dir: 'week10', n: 4 },
  { dir: 'week11', n: 5 },
  { dir: 'week12', n: 6 },
];

const STAMP = new Date().toLocaleDateString('en-NZ', {
  day: 'numeric', month: 'short', year: 'numeric',
});

const PRINT_CSS = `
  #hud, #progress, #counter, #seclabel, .navzone, #jump, #stage,
  #toast, #contents, #remotepanel, .deck, #deck { display: none !important; }
  /* Any stray width past 1280px makes Chrome shrink the sheet to fit, which
     would letterbox every slide. */
  html, body { background: #fff !important; overflow: visible !important;
               margin: 0 !important; padding: 0 !important;
               width: 1280px !important; height: auto !important; }
  #pdfroot { width: 1280px; margin: 0; padding: 0; display: block !important; }
  /* Deliberately no display here: the clones carry .active, so each deck's
     own rule decides. Modules 1-4 and 6 lay a slide out as flex, Module 5 as
     block, and forcing either one squashes the other. */
  #pdfroot .slide {
    position: relative !important; inset: auto !important;
    width: 1280px !important; height: 720px !important;
    min-height: 0 !important; max-height: none !important; opacity: 1 !important;
    transform: none !important; margin: 0 !important; overflow: hidden !important;
    visibility: visible !important;
    break-after: page; page-break-after: always;
  }
  #pdfroot .slide:last-child { break-after: auto; page-break-after: auto; }
  /* Below the decks' own .footnote, which every one of them pins 30px up. */
  #pdfroot .pdfstamp {
    position: absolute; left: 92px; right: 92px; bottom: 7px;
    display: flex; justify-content: space-between;
    font-family: var(--mono, monospace); font-size: 11px;
    color: var(--faint, #888); opacity: .75; pointer-events: none;
  }
`;

/* ---- installed in the page once, before the walk ---- */
function installRecorder() {
  const PAINTS = new Set(['line', 'path', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'image']);

  const shows = (el, root) => {
    for (let n = el; n && n !== root.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) < 0.05) return false;
    }
    return true;
  };

  // Keyed by content, not node identity: several decks rebuild nodes between
  // beats, and identity keys would read every rebuild as content being lost.
  const signature = (slide) => {
    const seen = new Set();
    slide.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'style' || tag === 'script' || tag === 'defs' || tag === 'marker') return;
      if (el.closest('defs')) return;
      if (el.children.length) return;
      let key = null;
      const text = el.textContent.trim().replace(/\s+/g, ' ');
      if (text) key = 't:' + text;
      else if (PAINTS.has(tag)) {
        try {
          const b = el.getBBox();
          key = `s:${tag}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
        } catch { key = 's:' + tag; }
      }
      if (key && shows(el, slide)) seen.add(key);
    });
    return seen;
  };

  const P = {
    pages: [], acc: new Set(), prevClone: null, prevSlide: null,
    slides: () => [...document.querySelectorAll('.slide')],
    signature,
  };
  window.__pdf = P;

  P.step = function () {
    const all = P.slides();
    let slide = document.querySelector('.slide.active');
    if (!slide) slide = all.find((s) => getComputedStyle(s).display !== 'none');
    if (!slide) return { end: true };
    const idx = all.indexOf(slide);
    const sig = signature(slide);

    if (P.prevSlide !== null && P.prevSlide !== idx) {
      P.pages.push({ idx: P.prevSlide, node: P.prevClone });
      P.acc = new Set();
    } else if (P.prevSlide !== null) {
      const lost = [...P.acc].some((k) => !sig.has(k));
      if (lost) { P.pages.push({ idx, node: P.prevClone }); P.acc = new Set(); }
    }
    sig.forEach((k) => P.acc.add(k));
    P.prevClone = slide.cloneNode(true);
    P.prevSlide = idx;
    return { idx, key: idx + '|' + [...sig].sort().join('') };
  };

  P.finish = function () {
    if (P.prevClone) P.pages.push({ idx: P.prevSlide, node: P.prevClone });
    return { reached: P.prevSlide };
  };
}

/* ---- run after the walk, once the print CSS is in ---- */
function buildPrintRoot({ label, stamp, total }) {
  const P = window.__pdf;
  const root = document.createElement('div');
  root.id = 'pdfroot';
  P.pages.forEach(({ idx, node }) => {
    const clone = node;
    clone.classList.add('active');
    clone.removeAttribute('hidden');
    const foot = document.createElement('div');
    foot.className = 'pdfstamp';
    foot.innerHTML = `<span>${label}</span><span>${stamp} &middot; ${idx + 1} / ${total}</span>`;
    clone.appendChild(foot);
    root.appendChild(clone);
  });
  document.body.appendChild(root);

  // Chrome's PDF renderer drops arrowheads whose marker paints with
  // `context-stroke`, and cloning duplicates marker ids besides. Give every
  // arrow its own marker with the colour already resolved. Runs after the
  // root is in the document so stroke colours compute.
  const SVGNS = 'http://www.w3.org/2000/svg';
  let n = 0;
  root.querySelectorAll('svg').forEach((svg) => {
    let defs = svg.querySelector('defs');
    svg.querySelectorAll('[marker-end], [marker-start], [marker-mid]').forEach((el) => {
      const colour = getComputedStyle(el).stroke;
      ['marker-start', 'marker-mid', 'marker-end'].forEach((attr) => {
        const ref = (el.getAttribute(attr) || '').match(/^url\(#(.+)\)$/);
        if (!ref) return;
        const src = svg.querySelector(`#${CSS.escape(ref[1])}`);
        if (!src) return;
        const copy = src.cloneNode(true);
        copy.id = `pdfmk${n++}`;
        copy.querySelectorAll('path, polygon, circle, rect, ellipse')
          .forEach((p) => p.setAttribute('fill', colour));
        if (!defs) {
          defs = document.createElementNS(SVGNS, 'defs');
          svg.insertBefore(defs, svg.firstChild);
        }
        defs.appendChild(copy);
        el.setAttribute(attr, `url(#${copy.id})`);
      });
    });
  });

  const counts = {};
  P.pages.forEach((p) => { counts[p.idx] = (counts[p.idx] || 0) + 1; });
  return {
    pages: P.pages.length,
    multi: Object.entries(counts)
      .filter(([, c]) => c > 1)
      .map(([slide, c]) => ({ slide: Number(slide) + 1, pages: c })),
  };
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  const want = process.argv.slice(2);
  const targets = want.length
    ? MODULES.filter((m) => want.includes(m.dir) || want.includes(String(m.n)))
    : MODULES;
  if (!targets.length) throw new Error(`no such module: ${want.join(' ')}`);

  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch();

  try {
    await waitForServer(`${base}/healthz`);

    for (const m of targets) {
      // A fresh context each time: the decks restore their last position from
      // localStorage, and we need to start at the very first slide.
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      await page.emulateMedia({ media: 'screen' });
      await page.goto(`${base}/${m.dir}/#0`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await page.addStyleTag({
        content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
      });

      const total = await page.evaluate(() => document.querySelectorAll('.slide').length);
      const title = await page.title();
      const label = title.replace(/^COSC264\s*[·:-]\s*/, '').trim() || `Module ${m.n}`;

      await page.evaluate(installRecorder);
      await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => {});

      // Some beats reveal nothing visible -- spacer fragments that only exist
      // to give a JS-driven slide another step -- so an unchanged snapshot is
      // not by itself the end of the deck. Only stop once we are on the last
      // slide and pressing on changes nothing.
      let last = null;
      let stall = 0;
      let steps = 0;
      for (; steps < MAX_STEPS; steps++) {
        const st = await page.evaluate(() => window.__pdf.step());
        if (st.end) break;
        stall = st.key === last ? stall + 1 : 0;
        if (stall >= 2 && st.idx >= total - 1) break;
        if (stall >= 15) break; // wedged; bail rather than spin
        last = st.key;
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(12);
      }
      const { reached } = await page.evaluate(() => window.__pdf.finish());
      if (reached !== total - 1) {
        throw new Error(
          `Module ${m.n}: the walk stopped on slide ${reached + 1} of ${total}. ` +
          `The PDF would be missing the rest, so nothing was written.`
        );
      }

      await page.addStyleTag({ content: PRINT_CSS });
      const info = await page.evaluate(buildPrintRoot, { label, stamp: STAMP, total });

      const file = path.join(OUT, `cosc264-module${m.n}.pdf`);
      await page.pdf({
        path: file,
        width: '1280px',
        height: '720px',
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        printBackground: true,
      });
      await ctx.close();

      const { size } = await stat(file);
      const extra = info.multi.length
        ? `  (${info.multi.length} split: ` +
          info.multi.slice(0, 6).map((x) => `${x.slide}×${x.pages}`).join(', ') +
          (info.multi.length > 6 ? ', …' : '') + ')'
        : '';
      console.log(
        `Module ${m.n}  ${String(total).padStart(3)} slides -> ` +
        `${String(info.pages).padStart(3)} pages  ${(size / 1e6).toFixed(1)} MB` +
        `  [${steps} beats]${extra}`
      );
      if (steps >= MAX_STEPS) console.warn(`  ! Module ${m.n} hit the step cap; deck may be truncated`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
