// Reproducible brand-asset generator (#282). Renders the Open Graph image from the
// same pulse mark as app/static/favicon.svg + the self-hosted Inter font, using the
// headless chromium that Playwright already ships for the e2e suite. #254 built the
// rasters ad-hoc with no committed script; this replaces that.
//
//   cd app && node scripts/gen-assets.mjs
//
// Only regenerates og-image.png (the sole asset carrying the wordmark). The square
// icons are the mark alone and don't change with the wordmark, so they're left
// byte-identical — regenerate them by hand only if the MARK itself changes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, '../static');

// Brand constants — keep in sync with docs/design-system.md.
const PETROL = '#123b40';
const WORDMARK = 'nabz'; // always lowercase
const TAGLINE = 'The pulse of your infrastructure';
const PULSE_PATH = 'M3 12h4l2.5-7 5 14 2.5-7H21'; // the mark, same as favicon.svg

const interB64 = readFileSync(resolve(staticDir, 'fonts/InterVariable.woff2')).toString('base64');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: 'Inter';
    font-weight: 100 900;
    font-display: block;
    src: url(data:font/woff2;base64,${interB64}) format('woff2');
  }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  .wrap {
    width: 1200px; height: 630px; background: ${PETROL};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased;
  }
  .brand { display: flex; align-items: center; gap: 40px; }
  .mark { width: 168px; height: 168px; }
  .word { font-weight: 600; font-size: 168px; line-height: 1; color: #fff; letter-spacing: -0.03em; }
  .tag { margin-top: 44px; font-weight: 500; font-size: 42px; color: rgba(255,255,255,0.72); letter-spacing: 0.01em; }
</style></head><body>
  <div class="wrap">
    <div class="brand">
      <svg class="mark" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="${PULSE_PATH}"/></svg>
      <span class="word">${WORDMARK}</span>
    </div>
    <div class="tag">${TAGLINE}</div>
  </div>
</body></html>`;

// CHROME_BIN lets you point at an already-installed chromium (CI, offline, or a
// version mismatch with the bundled one); otherwise Playwright's own is used.
const browser = await chromium.launch(
	process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}
);
const page = await browser.newPage({
	viewport: { width: 1200, height: 630 },
	deviceScaleFactor: 1
});
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
const out = resolve(staticDir, 'og-image.png');
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log(`wrote ${out} (1200x630)`);
