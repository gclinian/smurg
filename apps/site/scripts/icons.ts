// Draws the icons of smurg.ai that are not the SVG itself, from public/favicon.svg:
//
//   public/favicon.ico            16, 32 and 48 px in one file. What a browser, a crawler, a feed reader or a link
//                                 preview asks for at /favicon.ico when it has read no page, the icon of browsers
//                                 that show no SVG one, and (48 px) a size a search result can use.
//   public/apple-touch-icon.png   180 × 180: the icon of a page somebody put on a phone's home screen. The phone
//                                 rounds the corners itself and shows black where a picture is transparent, so
//                                 this one is the mark on a full square of its colour.
//
//   source scripts/env.sh && pnpm --filter @smurg/site run icons
//
// Run it after changing public/favicon.svg, then commit the two files (test/site.test.ts reads their sizes, their
// corners and their colour). It writes those two files and nothing else. Each size is drawn by headless Chrome, as
// scripts/social-card.ts draws the preview pictures: a fresh profile in a temporary folder and no network. The
// pages name the icons in their `<head>` (ICON_LINKS in ./site.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAVICON_SIZES, PUBLIC_DIR, TOUCH_ICON_SIZE } from './site.ts';
import { chrome } from './social-card.ts';

/** The rounded corners of the mark's background, as public/favicon.svg writes them. */
const ROUNDED = ' rx="8" fill=';

/** The drawing with a square background instead of the rounded one (the touch icon's). */
export function squareIcon(svg: string): string {
  if (svg.split(ROUNDED).length !== 2) throw new Error(`public/favicon.svg no longer has one background with${ROUNDED}…: scripts/icons.ts must learn its new shape`);
  return svg.replace(ROUNDED, ' fill=');
}

/** One .ico file that holds the given PNGs (each entry is the PNG as it is, which every current browser reads). */
export function ico(images: readonly { readonly size: number; readonly png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // an icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0); // width
    entry.writeUInt8(size, 1); // height
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

/** Draws `svg` as a PNG of `size` × `size`; where the drawing has nothing, the PNG is transparent. */
function draw(browser: string, svg: string, size: number, name: string, work: string): Buffer {
  const page = join(work, `${name}.html`);
  writeFileSync(
    page,
    `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<style>html, body { margin: 0; background: transparent; } svg { display: block; width: ${size}px; height: ${size}px; }</style>\n</head>\n<body>${svg}</body>\n</html>\n`,
  );
  const out = join(work, `${name}.png`);
  const result = spawnSync(
    browser,
    [
      '--headless',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${size},${size}`,
      `--user-data-dir=${join(work, `profile-${name}`)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--default-background-color=00000000',
      `--screenshot=${out}`,
      pathToFileURL(page).href,
    ],
    // On macOS Chrome keeps its temporary files where MAC_CHROMIUM_TMPDIR says, not TMPDIR.
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MAC_CHROMIUM_TMPDIR: work } },
  );
  if (result.status !== 0 || !existsSync(out)) {
    throw new Error(`Chrome did not draw ${name} (${result.error?.message ?? `exit ${result.status ?? result.signal}`}): ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  const png = readFileSync(out);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png.subarray(1, 4).toString('latin1') !== 'PNG' || width !== size || height !== size) throw new Error(`Chrome drew ${name} as ${width} × ${height}, not ${size} × ${size}`);
  return png;
}

function main(): number {
  const browser = chrome();
  const work = mkdtempSync(join(tmpdir(), 'smurg-icons-'));
  try {
    const svg = readFileSync(join(PUBLIC_DIR, 'favicon.svg'), 'utf8').trim();
    const favicon = ico(FAVICON_SIZES.map((size) => ({ size, png: draw(browser, svg, size, `favicon-${size}`, work) })));
    writeFileSync(join(PUBLIC_DIR, 'favicon.ico'), favicon);
    console.log(`icons: ${join(PUBLIC_DIR, 'favicon.ico')} (${FAVICON_SIZES.join(', ')} px; ${favicon.length} bytes)`);
    const touch = draw(browser, squareIcon(svg), TOUCH_ICON_SIZE, 'apple-touch-icon', work);
    writeFileSync(join(PUBLIC_DIR, 'apple-touch-icon.png'), touch);
    console.log(`icons: ${join(PUBLIC_DIR, 'apple-touch-icon.png')} (${TOUCH_ICON_SIZE} px; ${touch.length} bytes)`);
    return 0;
  } catch (error) {
    console.error(`icons: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
