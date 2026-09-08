/**
 * Build printable PDFs from the decks.
 *
 * The decks are the source of truth; these PDFs are derived artefacts. Run
 * `npm run pdf` after changing a deck and commit the result alongside it.
 *
 *   node tools/build-pdf.mjs            # every module
 *   node tools/build-pdf.mjs week10     # just these
 *
 * One page per slide, at the deck's own 1280x720 geometry so the printed
 * layout is the one that was verified on screen. Slides whose fragments
 * REPLACE each other (hot-fragment cards, a badge that flips from 0 to 1)
 * would lose content if we simply revealed everything, so those get one page
 * per state -- the fewest pages that still show every fragment at least once.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PDF_PORT || 4321);
const OUT = path.join(ROOT, 'public', 'pdf');

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

/* Lay each slide out statically at its designed size, one per page. The deck
   ships its own A4 @media print rules; we render as `screen` so those never
   apply and this geometry is the only one in play. */
const PRINT_CSS = `
  #hud, #progress, #counter, #seclabel, .navzone, #jump, #stage,
  #toast, #contents, #remotepanel { display: none !important; }
  /* Any stray width past 1280px makes Chrome shrink the whole page to fit,
     which would letterbox every slide inside a larger sheet. */
  html, body { background: #fff !important; overflow: visible !important;
               margin: 0 !important; padding: 0 !important;
               width: 1280px !important; height: auto !important; }
  #pdfroot { width: 1280px; margin: 0; padding: 0; }
  #pdfroot .slide {
    position: relative !important; inset: auto !important;
    display: flex !important; width: 1280px !important; height: 720px !important;
    min-height: 0 !important; max-height: none !important;
    transform: none !important; margin: 0 !important; overflow: hidden !important;
    break-after: page; page-break-after: always;
  }
  #pdfroot .slide:last-child { break-after: auto; page-break-after: auto; }
  #pdfroot .frag { transition: none !important; }
  #pdfroot .pdfstamp {
    position: absolute; left: 92px; right: 92px; bottom: 26px;
    display: flex; justify-content: space-between;
    font-family: var(--mono); font-size: 12.5px; color: var(--faint);
    pointer-events: none;
  }
`;

/**
 * Runs inside the page, BEFORE the print CSS goes in: a slide is
 * `display:none` until it is the current one, so it has to be made visible
 * for its fragment states to be measurable at all.
 *
 * Returns one entry per printed page, in order.
 */
function planPages() {
  const slides = [...document.querySelectorAll('.slide')];

  let idx = 0;
  document.querySelectorAll('.slide *').forEach((el) => { el.dataset.pidx = String(idx++); });

  // Opacity and display are inherited down the tree in effect but not in
  // computed style, so visibility has to be resolved against the ancestors.
  const shows = (el, root) => {
    for (let n = el; n && n !== root.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) < 0.05) return false;
    }
    return true;
  };

  const PAINTS = new Set(['line', 'path', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'image', 'tspan']);
  const signature = (slide) => {
    const seen = new Set();
    slide.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'style' || tag === 'defs' || tag === 'marker') return;
      if (el.closest('defs')) return;
      const leaf = el.children.length === 0;
      if (!(leaf && (el.textContent.trim() || PAINTS.has(tag)))) return;
      if (shows(el, slide)) seen.add(el.dataset.pidx);
    });
    return seen;
  };

  const plan = [];
  const report = [];

  slides.forEach((slide, si) => {
    const frags = [...slide.querySelectorAll('.frag')];
    if (!frags.length) { plan.push({ si, beat: -1 }); report.push(1); return; }

    const wasActive = slide.classList.contains('active');
    slide.classList.add('active');
    const sigs = [];
    for (let i = 0; i < frags.length; i++) {
      frags.forEach((f, j) => f.classList.toggle('on', j <= i));
      sigs.push(signature(slide));
    }
    if (!wasActive) slide.classList.remove('active');

    // Walk the beats accumulating what has been shown. The moment something
    // already shown disappears, close a page at the previous beat and start
    // accumulating again -- the fewest pages that lose nothing.
    const beats = [];
    let acc = new Set();
    for (let i = 0; i < sigs.length; i++) {
      const lost = [...acc].some((k) => !sigs[i].has(k));
      if (lost && i > 0) { beats.push(i - 1); acc = new Set(sigs[i]); }
      else sigs[i].forEach((k) => acc.add(k));
    }
    beats.push(sigs.length - 1);
    beats.forEach((b) => plan.push({ si, beat: b }));
    report.push(beats.length);
  });

  const multi = report
    .map((c, i) => (c > 1 ? { slide: i + 1, pages: c } : null))
    .filter(Boolean);
  return { slides: slides.length, plan, multi };
}

/** Runs inside the page, after the print CSS: clone each planned page out. */
function buildPrintRoot({ plan, label, stamp, total }) {
  const slides = [...document.querySelectorAll('.slide')];
  const root = document.createElement('div');
  root.id = 'pdfroot';
  plan.forEach(({ si, beat }) => {
    const slide = slides[si];
    const frags = [...slide.querySelectorAll('.frag')];
    frags.forEach((f, j) => f.classList.toggle('on', beat < 0 || j <= beat));
    const clone = slide.cloneNode(true);
    clone.classList.add('active');
    const foot = document.createElement('div');
    foot.className = 'pdfstamp';
    foot.innerHTML = `<span>${label}</span><span>${stamp} &middot; ${si + 1} / ${total}</span>`;
    clone.appendChild(foot);
    root.appendChild(clone);
  });
  document.body.appendChild(root);

  // Chrome's PDF renderer drops arrowheads whose marker paints with
  // `context-stroke`, and cloning a slide duplicates its marker ids besides.
  // Give every arrow its own marker with the colour already resolved.
  // Runs after the root is in the document so stroke colours compute.
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
        copy.querySelectorAll('path, polygon, circle, rect, ellipse').forEach((p) => {
          p.setAttribute('fill', colour);
        });
        if (!defs) {
          defs = document.createElementNS(SVGNS, 'defs');
          svg.insertBefore(defs, svg.firstChild);
        }
        defs.appendChild(copy);
        el.setAttribute(attr, `url(#${copy.id})`);
      });
    });
  });
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
  const targets = want.length ? MODULES.filter((m) => want.includes(m.dir) || want.includes(String(m.n))) : MODULES;
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // The deck's own @media print rules reflow to A4; render as screen so the
    // fixed geometry above is the only layout in play.
    await page.emulateMedia({ media: 'screen' });

    for (const m of targets) {
      await page.goto(`${base}/${m.dir}/?print`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
      });
      const title = await page.title();
      const label = title.replace(/^COSC264\s*[·:-]\s*/, '').trim() || `Module ${m.n}`;

      // Fragment reveals are transitions. Computed opacity read immediately
      // after a class change is still the pre-transition value, which would
      // make every opacity-driven swap look like nothing had changed.
      await page.addStyleTag({
        content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
      });
      const info = await page.evaluate(planPages);
      await page.addStyleTag({ content: PRINT_CSS });
      await page.evaluate(buildPrintRoot, {
        plan: info.plan, label, stamp: STAMP, total: info.slides,
      });

      const file = path.join(OUT, `cosc264-module${m.n}.pdf`);
      await page.pdf({
        path: file,
        width: '1280px',
        height: '720px',
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        printBackground: true,
        preferCSSPageSize: false,
      });

      const { size } = await stat(file);
      const extra = info.multi.length
        ? `  (${info.multi.length} slide${info.multi.length > 1 ? 's' : ''} split: ` +
          info.multi.slice(0, 8).map((x) => `${x.slide}×${x.pages}`).join(', ') +
          (info.multi.length > 8 ? ', …' : '') + ')'
        : '';
      console.log(
        `Module ${m.n}  ${String(info.slides).padStart(3)} slides -> ` +
        `${String(info.plan.length).padStart(3)} pages  ${(size / 1e6).toFixed(1)} MB${extra}`
      );
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
