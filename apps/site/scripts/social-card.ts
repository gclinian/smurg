// Draws the preview pictures of smurg.ai: what LinkedIn, Slack, iMessage, LINE, WhatsApp, … show for a link to the
// site (Open Graph `og:image`). One PNG per language, 1200 × 630, from the words of SOCIAL_CARD in ./site.ts:
//
//   source scripts/env.sh && pnpm --filter @smurg/site run social-card
//
// Run it after changing a home page's h1 (test/site.test.ts holds SOCIAL_CARD to the h1), then commit the PNGs. It
// writes public/og.png and public/zh-TW/og.png, nothing else. The picture is HTML drawn by headless Chrome:
// SMURG_TEST_CHROME, or Google Chrome where the browser tests look for it (apps/web/e2e/chrome.ts). Chrome gets a
// fresh profile in a temporary folder and no network (every host name fails to resolve), so it draws with the
// machine's own fonts and downloads nothing; the committed pictures were drawn on macOS.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeHtml } from './markdown.ts';
import { HTML_LANG, LANGS, MARK, PUBLIC_DIR, SOCIAL_CARD, SOCIAL_CARD_SIZE, type Lang } from './site.ts';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];

function chrome(): string {
  const named = process.env['SMURG_TEST_CHROME'];
  if (named !== undefined && named !== '') {
    if (!isAbsolute(named) || !existsSync(named)) throw new Error(`SMURG_TEST_CHROME=${named} is not an absolute path to a browser`);
    return named;
  }
  const found = CHROME_PATHS.find((path) => existsSync(path));
  if (found === undefined) throw new Error('no Chrome: install Google Chrome, or name a Chrome or Chromium with SMURG_TEST_CHROME');
  return found;
}

/** The picture as a page: the colours and fonts of public/style.css (light), the mark, the h1, the labels. */
export function cardHtml(lang: Lang): string {
  const card = SOCIAL_CARD[lang];
  return `<!doctype html>
<html lang="${HTML_LANG[lang]}">
<head>
<meta charset="utf-8">
<style>
:root {
  --bg: #ffffff;
  --panel: #f5f6f8;
  --border: #d9dee6;
  --text: #1b1f27;
  --muted: #485262;
  --accent: #1d4ed8;
}
* { box-sizing: border-box; }
html, body { margin: 0; width: ${SOCIAL_CARD_SIZE.width}px; height: ${SOCIAL_CARD_SIZE.height}px; overflow: hidden; background: var(--bg); }
body {
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', 'Hiragino Sans', 'Helvetica Neue', Arial, sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.card {
  width: 100%;
  height: 100%;
  padding: 64px 80px 60px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  border-top: 12px solid var(--accent);
}
.brand { display: flex; align-items: center; gap: 18px; font-size: 42px; font-weight: 700; letter-spacing: -0.01em; }
.brand svg { width: 58px; height: 58px; }
.mark-bg { fill: var(--accent); }
.mark-fg { fill: var(--bg); }
.mark-ln { fill: none; stroke: var(--bg); stroke-width: 2; stroke-linecap: round; }
h1 { margin: 0; font-size: 70px; line-height: 1.07; letter-spacing: -0.035em; font-weight: 750; }
html:lang(zh-Hant-TW) h1 { font-size: 66px; line-height: 1.3; letter-spacing: 0.01em; font-weight: 700; }
.foot { display: flex; align-items: center; justify-content: space-between; }
.chips { display: flex; gap: 14px; }
.chip { border: 2px solid var(--border); background: var(--panel); border-radius: 999px; padding: 8px 22px; font-size: 26px; color: var(--muted); }
.site { font-size: 30px; font-weight: 650; color: var(--accent); }
</style>
</head>
<body>
<div class="card">
  <div class="brand">${MARK}<span>smurg</span></div>
  <h1>${card.lines.map((line) => escapeHtml(line)).join('<br>')}</h1>
  <div class="foot">
    <div class="chips">${card.chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>
    <span class="site">smurg.ai</span>
  </div>
</div>
</body>
</html>
`;
}

/** Draws one language's picture into public/. */
function draw(browser: string, lang: Lang, work: string): string {
  const page = join(work, `card-${lang}.html`);
  writeFileSync(page, cardHtml(lang));
  const out = join(PUBLIC_DIR, SOCIAL_CARD[lang].path.slice(1));
  const temporary = join(work, `card-${lang}.png`);
  const result = spawnSync(
    browser,
    [
      '--headless',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${SOCIAL_CARD_SIZE.width},${SOCIAL_CARD_SIZE.height}`,
      `--user-data-dir=${join(work, `profile-${lang}`)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      `--screenshot=${temporary}`,
      pathToFileURL(page).href,
    ],
    // On macOS Chrome keeps its temporary files where MAC_CHROMIUM_TMPDIR says, not TMPDIR.
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MAC_CHROMIUM_TMPDIR: work } },
  );
  if (result.status !== 0 || !existsSync(temporary)) {
    throw new Error(`Chrome did not draw the ${lang} picture (${result.error?.message ?? `exit ${result.status ?? result.signal}`}): ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  const png = readFileSync(temporary);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png.subarray(1, 4).toString('latin1') !== 'PNG' || width !== SOCIAL_CARD_SIZE.width || height !== SOCIAL_CARD_SIZE.height) {
    throw new Error(`Chrome drew a ${width} × ${height} picture for ${lang}, not ${SOCIAL_CARD_SIZE.width} × ${SOCIAL_CARD_SIZE.height}`);
  }
  writeFileSync(out, png);
  return `${out} (${Math.round(png.length / 1024)} KB)`;
}

function main(): number {
  const browser = chrome();
  const work = mkdtempSync(join(tmpdir(), 'smurg-social-card-'));
  try {
    for (const lang of LANGS) console.log(`social card: ${draw(browser, lang, work)}`);
    return 0;
  } catch (error) {
    console.error(`social card: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
