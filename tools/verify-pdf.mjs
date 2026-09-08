/**
 * Check that nothing a deck shows is missing from its PDF.
 *
 *   node tools/verify-pdf.mjs            # every module
 *   node tools/verify-pdf.mjs week7 week8
 *
 * Runs the real build pipeline from build-pdf.mjs -- same walk, same
 * page-selection, same print root -- then compares two sets measured the same
 * way in the DOM:
 *
 *   what the deck shows   every string visible at any beat, including the
 *                         ones later replaced, which is exactly what a naive
 *                         export drops
 *   what the PDF shows    every string visible on the built pages
 *
 * The comparison is deliberately NOT made against text pulled back out of the
 * finished PDF. Chrome splits wrapped text into separately positioned runs,
 * so pdftotext reorders sentences and runs neighbouring words together
 * ("Thecrossing"); that produces false alarms rather than findings. Whether a
 * string is present in the print root is exact.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODULES, PRINT_CSS, STAMP,
  installRecorder, buildPrintRoot, collectRootText, waitForServer,
} from './build-pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PDF_PORT || 4322);
const MAX_STEPS = 4000;

async function main() {
  const want = process.argv.slice(2);
  const targets = want.length
    ? MODULES.filter((m) => want.includes(m.dir) || want.includes(String(m.n)))
    : MODULES;

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch();
  let bad = 0;

  try {
    await waitForServer(`${base}/healthz`);

    for (const m of targets) {
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

      const onScreen = new Map(); // text -> slide it first appeared on
      let last = null, stall = 0, steps = 0;

      for (; steps < MAX_STEPS; steps++) {
        const st = await page.evaluate(() => window.__pdf.step());
        if (st.end) break;
        st.texts.forEach((t) => { if (!onScreen.has(t)) onScreen.set(t, st.idx + 1); });
        stall = st.key === last ? stall + 1 : 0;
        if (stall >= 2 && st.idx >= total - 1) break;
        if (stall >= 15) break;
        last = st.key;
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(12);
      }
      const { reached } = await page.evaluate(() => window.__pdf.finish());

      await page.addStyleTag({ content: PRINT_CSS });
      const info = await page.evaluate(buildPrintRoot, { label, stamp: STAMP, total });
      const inPdf = new Set(await page.evaluate(collectRootText));
      await ctx.close();

      const missing = [...onScreen.entries()]
        .filter(([t]) => !inPdf.has(t))
        .map(([text, slide]) => ({ text, slide }));

      const ok = missing.length === 0 && reached === total - 1;
      if (!ok) bad++;
      console.log(
        `\n${ok ? 'OK  ' : 'FAIL'} Module ${m.n}  ${total} slides, ${steps} beats, ` +
        `${info.pages} pages, ${onScreen.size} distinct strings on screen`
      );
      if (reached !== total - 1) console.log(`     ! walk stopped at slide ${reached + 1}/${total}`);
      if (missing.length) {
        console.log(`     ! ${missing.length} string(s) shown by the deck but on no page:`);
        missing.slice(0, 25).forEach((v) =>
          console.log(`         slide ${String(v.slide).padStart(2)}: ${JSON.stringify(v.text.slice(0, 88))}`));
        if (missing.length > 25) console.log(`         … and ${missing.length - 25} more`);
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
