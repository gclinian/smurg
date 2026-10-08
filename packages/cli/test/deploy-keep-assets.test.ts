// scripts/deploy-relay.ts `--keep-assets DIR` (0.5.1, DESIGN E2 and D2's "keep the previous chunks"): a deploy of the
// relay keeps the content-hashed files of the PREVIOUS published web app beside the new ones in what it uploads, so
// that a tab that was open before the deploy never asks for a file that is gone (the relay would answer the page
// itself, HTTP 200 text/html, and that part of the old page breaks: W/FOUND-U7; at the 0.5.1 deploy the open tabs are
// 0.5.0 pages, which no code of 0.5.1 can help).
//
// Nothing is deployed here and nothing is built: the copy runs on scratch folders that stand in for the previous
// build's assets folder and for apps/web/dist. What is covered: which folders are taken at all (nothing but
// content-hashed files), that only <dist>/assets is written, that index.html is always the new build's, that a name
// can never get other bytes, the order (build, copy, check) and what a run (also a dry run) shows; and that a run
// WITHOUT the option says first what a deploy then does to the pages that are open (sceptic V4-2: a plain deploy of
// 0.5.1 emptied every open 0.5.0 tab, and the script said nothing).
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '@smurg/daemon/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSET_MAX_BYTES,
  HASHED_ASSET,
  KEEP_ASSETS_USAGE,
  KeepAssetsError,
  buildWebKeeping,
  keepPreviousAssets,
  keptReport,
  noKeepAssetsNotice,
  previousAssets,
  run,
  takeKeepAssets,
} from '../../../scripts/deploy-relay.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

async function scratch(): Promise<string> {
  const dir = await createTempDir('deploy-keep');
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

async function folder(dir: string, files: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

/** Names as the web build of 0.5.0 really has them (apps/web/dist/assets: 139 files, .js, .css and one .ttf). */
const REAL_NAMES = [
  'index-C1FBP0hx.js',
  'Workbench-LryUXbHp.js',
  'Workbench-DntWAQjO.css',
  'ProjectSettingsReview-hPWaocjf.css',
  'editor.api-SOhylmUr.js',
  'editor.worker-DWPaKKV_.js',
  'codicon-DF1abBS2.ttf',
  'bicep-B5-_aFwp.js',
  'flow9-C5_-GSwl.js',
  'agents-YtpqyN_J.css',
  'abap-08VXUWAP.js',
];

/** The previous version's assets folder, and the new build (dist) with one file the two versions share. */
async function twoBuilds(): Promise<{ previous: string; dist: string }> {
  const base = await scratch();
  const previous = await folder(join(base, 'previous', 'apps', 'web', 'dist', 'assets'), {
    'index-OLDold00.js': 'old entry',
    'Workbench-OLDold01.js': 'old workbench',
    'Workbench-OLDold02.css': 'old styles',
    'codicon-DF1abBS2.ttf': 'the font both versions ship',
  });
  const dist = join(base, 'new', 'apps', 'web', 'dist');
  await folder(dist, { 'index.html': '<!doctype html><div id="root"></div><script type="module" src="/assets/index-NEWnew00.js"></script>', _headers: '/*\n  X-Frame-Options: DENY\n', 'third-party-notices.txt': 'new notices' });
  await folder(join(dist, 'assets'), { 'index-NEWnew00.js': 'new entry', 'Workbench-NEWnew01.js': 'new workbench', 'codicon-DF1abBS2.ttf': 'the font both versions ship' });
  return { previous, dist };
}

const errorOf = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => 'no error',
    (err: unknown) => {
      expect(err).toBeInstanceOf(KeepAssetsError);
      return (err as Error).message;
    },
  );

describe('scripts/deploy-relay.ts --keep-assets: which folder is taken', () => {
  it('a content-hashed name is <name>-<8 characters>.<ext>; the real names of a web build are, everything else is not', () => {
    for (const name of REAL_NAMES) expect(HASHED_ASSET.test(name), name).toBe(true);
    for (const name of [
      'index.html',
      'index.js',
      'manifest.json',
      '_headers',
      '.assetsignore',
      '.DS_Store',
      'third-party-notices.txt',
      'index-C1FBP0hx.js.map',
      'index-C1FBP0h.js', // seven characters
      'index-C1FBP0hx.html',
      'index-C1FBP0hx.json',
      '-C1FBP0hx.js',
      '../index-C1FBP0hx.js',
      'a/index-C1FBP0hx.js',
      'index-C1FBP0hx.js ',
      'index-C1FB/0hx.js',
    ]) {
      expect(HASHED_ASSET.test(name), name).toBe(false);
    }
  });

  it('takes a folder that holds nothing but such files, and says what it found', async () => {
    const { previous } = await twoBuilds();
    const found = await previousAssets(previous);
    expect(found.dir).toBe(previous);
    expect(found.files).toEqual([
      { name: 'Workbench-OLDold01.js', bytes: 13 },
      { name: 'Workbench-OLDold02.css', bytes: 10 },
      { name: 'codicon-DF1abBS2.ttf', bytes: 27 },
      { name: 'index-OLDold00.js', bytes: 9 },
    ]);
  });

  it('refuses everything else before anything is built: a missing or empty folder, a file, a symlink, the build\'s top folder, a folder inside, a name without a hash, a file too large', async () => {
    const base = await scratch();
    expect(await errorOf(previousAssets(join(base, 'nowhere')))).toBe(`--keep-assets: ${join(base, 'nowhere')} does not exist`);
    const empty = await folder(join(base, 'empty'), {});
    expect(await errorOf(previousAssets(empty))).toBe(`--keep-assets: ${empty} is empty`);
    await writeFile(join(base, 'a-file'), 'x');
    expect(await errorOf(previousAssets(join(base, 'a-file')))).toContain('is not a folder');
    const { previous, dist } = await twoBuilds();
    await symlink(previous, join(base, 'link'));
    expect(await errorOf(previousAssets(join(base, 'link')))).toContain('is not a folder (a symlink is not followed)');

    // The top folder of a build: index.html must never be taken for an asset; the message says which folder to give.
    const top = await errorOf(previousAssets(dist));
    expect(top).toContain(`${dist} is not the assets folder of a web build`);
    expect(top).toContain('  index.html (not a content-hashed name)');
    expect(top).toContain('  assets (a folder)');
    expect(top).toContain(`give its assets folder, ${join(dist, 'assets')}`);

    const odd = await folder(join(base, 'odd'), { 'index-OLDold00.js': 'x', 'manifest.json': '{}', 'index-OLDold00.js.map': '{}' });
    await mkdir(join(odd, 'nested-OLDold09.js'));
    await symlink('/etc/hosts', join(odd, 'hosts-OLDold08.js'));
    const message = await errorOf(previousAssets(odd));
    for (const line of ['  manifest.json (not a content-hashed name)', '  index-OLDold00.js.map (not a content-hashed name)', '  nested-OLDold09.js (a folder)', '  hosts-OLDold08.js (a symlink)']) expect(message).toContain(line);
    expect(message).not.toContain('  index-OLDold00.js (');

    const big = await folder(join(base, 'big'), { 'video-OLDold07.js': '' });
    await truncate(join(big, 'video-OLDold07.js'), ASSET_MAX_BYTES + 1);
    expect(await errorOf(previousAssets(big))).toContain(`  video-OLDold07.js (${ASSET_MAX_BYTES + 1} bytes: more than one asset may have)`);
  });
});

describe('scripts/deploy-relay.ts --keep-assets: what is copied', () => {
  it('the previous files go into <dist>/assets beside the new ones; index.html, _headers and every new file are byte for byte the new build\'s', async () => {
    const { previous, dist } = await twoBuilds();
    const before = { index: await readFile(join(dist, 'index.html')), headers: await readFile(join(dist, '_headers')), entry: await readFile(join(dist, 'assets', 'index-NEWnew00.js')) };
    const found = await previousAssets(previous);
    const result = await keepPreviousAssets(found, dist);
    expect(result.added.map((f) => f.name)).toEqual(['Workbench-OLDold01.js', 'Workbench-OLDold02.css', 'index-OLDold00.js']);
    // The file both versions ship under one name is the same bytes: left alone, counted.
    expect(result.unchanged.map((f) => f.name)).toEqual(['codicon-DF1abBS2.ttf']);
    expect((await readdir(join(dist, 'assets'))).sort()).toEqual(['Workbench-NEWnew01.js', 'Workbench-OLDold01.js', 'Workbench-OLDold02.css', 'codicon-DF1abBS2.ttf', 'index-NEWnew00.js', 'index-OLDold00.js']);
    expect(await readFile(join(dist, 'assets', 'index-OLDold00.js'), 'utf8')).toBe('old entry');
    // Nothing outside assets/ was written or added, and no new file changed.
    expect((await readdir(dist)).sort()).toEqual(['_headers', 'assets', 'index.html', 'third-party-notices.txt']);
    expect((await readFile(join(dist, 'index.html'))).equals(before.index)).toBe(true);
    expect((await readFile(join(dist, '_headers'))).equals(before.headers)).toBe(true);
    expect((await readFile(join(dist, 'assets', 'index-NEWnew00.js'))).equals(before.entry)).toBe(true);
    // The source folder is only read.
    expect((await readdir(previous)).sort()).toEqual(['Workbench-OLDold01.js', 'Workbench-OLDold02.css', 'codicon-DF1abBS2.ttf', 'index-OLDold00.js']);

    // Run again (a second deploy from the same folders): everything is already there, nothing is copied twice.
    const again = await keepPreviousAssets(found, dist);
    expect(again.added).toEqual([]);
    expect(again.unchanged).toHaveLength(4);
  });

  it('one name with two contents stops it before anything is copied; the new file is never replaced', async () => {
    const { previous, dist } = await twoBuilds();
    await writeFile(join(previous, 'index-NEWnew00.js'), 'NOT the new entry');
    const message = await errorOf(previousAssets(previous).then((found) => keepPreviousAssets(found, dist)));
    expect(message).toContain('index-NEWnew00.js is in the new build AND in');
    expect(message).toContain('Nothing was copied or replaced; the deploy stops.');
    expect(await readFile(join(dist, 'assets', 'index-NEWnew00.js'), 'utf8')).toBe('new entry');
    expect((await readdir(join(dist, 'assets'))).sort()).toEqual(['Workbench-NEWnew01.js', 'codicon-DF1abBS2.ttf', 'index-NEWnew00.js']);
    // A new build without an assets folder is not something to copy into.
    const base = await scratch();
    const bare = await folder(join(base, 'dist'), { 'index.html': 'x' });
    const { previous: fine } = await twoBuilds();
    expect(await errorOf(previousAssets(fine).then((found) => keepPreviousAssets(found, bare)))).toContain('the new web build has no assets folder');
    expect(existsSync(join(bare, 'assets'))).toBe(false);
  });

  it('step 4 with --keep-assets: the web build, THEN the copy, THEN the check of the folder as it will be uploaded; the run lists what it keeps', async () => {
    const { previous, dist } = await twoBuilds();
    const found = await previousAssets(previous);
    const order: string[] = [];
    const lines: string[] = [];
    let seenByCheck: string[] = [];
    const step = buildWebKeeping(found, {
      webDist: dist,
      out: (line) => lines.push(line),
      // The real build empties the folder first: a file an earlier deploy kept there is gone, the new files are back.
      build: async () => {
        order.push('build');
        await writeFile(join(dist, 'assets', 'index-NEWnew00.js'), 'new entry');
      },
      check: async () => {
        order.push('check');
        seenByCheck = (await readdir(join(dist, 'assets'))).sort();
      },
    });
    await step();
    expect(order).toEqual(['build', 'check']);
    expect(seenByCheck).toContain('index-OLDold00.js');
    expect(lines).toEqual([
      `  --keep-assets ${previous}`,
      '  Kept beside the new build in apps/web/dist/assets: 3 files of the previous version (0.0 MB), so that a tab opened before this deploy still finds them.',
      '  Already in the new build under the same name and bytes (unchanged since then): 1.',
      '    assets/Workbench-OLDold01.js  (13 bytes)',
      '    assets/Workbench-OLDold02.css  (10 bytes)',
      '    assets/index-OLDold00.js  (9 bytes)',
      '  index.html and everything outside assets/ are the new build only.',
    ]);
    expect(keptReport(found, { added: [found.files[0] as (typeof found.files)[number]], unchanged: [] })[1]).toContain('1 file of the previous version');

    // A build that fails: nothing is copied and the check does not run.
    const failing = buildWebKeeping(found, { webDist: dist, out: () => {}, build: () => Promise.reject(new Error('vite failed')), check: async () => void order.push('check-2') });
    await expect(failing()).rejects.toThrow('vite failed');
    expect(order).toEqual(['build', 'check']);
  });
});

describe('scripts/deploy-relay.ts --keep-assets: the arguments', () => {
  it('the option is taken out of the arguments in both forms; every other argument reaches the guided deploy as it was', () => {
    expect(takeKeepAssets(['--dry-run', '--keep-assets', '/prev/assets', '--url', 'https://relay.example'])).toEqual({ rest: ['--dry-run', '--url', 'https://relay.example'], dir: '/prev/assets' });
    expect(takeKeepAssets(['--keep-assets=/prev/assets'])).toEqual({ rest: [], dir: '/prev/assets' });
    expect(takeKeepAssets(['--check', 'https://relay.example'])).toEqual({ rest: ['--check', 'https://relay.example'], dir: undefined });
    for (const bad of [['--keep-assets'], ['--keep-assets', '--dry-run'], ['--keep-assets='], ['--keep-assets', '/a', '--keep-assets', '/b'], ['--keep-assets=/a', '--keep-assets=/b']]) {
      expect(() => takeKeepAssets(bad), bad.join(' ')).toThrow(KeepAssetsError);
    }
  });

  it('a folder that is refused, or --keep-assets with --check, ends with exit code 2 before the guided deploy starts (nothing is built, nothing is contacted)', async () => {
    const base = await scratch();
    const calls: string[] = [];
    const deps = {
      buildWeb: async () => void calls.push('build'),
      fetch: (async () => {
        calls.push('fetch');
        return new Response('', { status: 500 });
      }) as typeof fetch,
      out: (line: string) => void calls.push(`out ${line}`),
    };
    let err = '';
    expect(await run(['--dry-run', '--keep-assets', join(base, 'nowhere')], { ...deps, err: (text) => (err += text) })).toBe(2);
    expect(err).toBe(`\ndeploy-relay: --keep-assets: ${join(base, 'nowhere')} does not exist\n`);
    const { previous } = await twoBuilds();
    err = '';
    expect(await run(['--check', 'https://relay.example', '--keep-assets', previous], { ...deps, err: (text) => (err += text) })).toBe(2);
    expect(err).toBe('\ndeploy-relay: --keep-assets goes with a deploy or --dry-run: --check deploys nothing\n');
    err = '';
    expect(await run(['--keep-assets'], { ...deps, err: (text) => (err += text) })).toBe(2);
    expect(err).toContain('--keep-assets needs a folder');
    expect(calls).toEqual([]);
  });

  it('WITHOUT --keep-assets a deploy, and a dry run, say first what that does to the pages that are open, and name the option; with it, with --check and with --help nothing is said (sceptic V4-2)', async () => {
    const { previous } = await twoBuilds();
    // The guided deploy itself is not run here: what matters is what was said BEFORE it starts (before anything is built or uploaded).
    const ran = async (argv: readonly string[]): Promise<{ code: number; seen: string[] }> => {
      const seen: string[] = [];
      const code = await run(
        argv,
        { out: (line) => seen.push(line), err: (text) => seen.push(`err ${text}`) },
        {
          deploy: async (rest) => {
            seen.push(`DEPLOY ${rest.join(' ')}`);
            return 0;
          },
        },
      );
      return { code, seen };
    };
    const deploy = await ran(['--url', 'https://relay.example']);
    expect(deploy.code).toBe(0);
    expect(deploy.seen).toEqual([...noKeepAssetsNotice('deploy'), 'DEPLOY --url https://relay.example']);
    expect(noKeepAssetsNotice('deploy')).toEqual([
      'deploy-relay: this deploy is run WITHOUT --keep-assets.',
      '  It replaces every file of the web app that is live now. A page that is open in a browser when the deploy goes live will not find the code it loads',
      '  later (the files are named by their content, and the old names are gone): that part of the page stays broken, or the page goes empty, until the',
      '  person reloads it.',
      "  To keep the previous version's files served beside the new ones, stop now (Ctrl-C) and run it again with --keep-assets DIR",
      '  (scripts/deploy-relay.sh --help says how to make DIR from the tag of the version that is live).',
      '',
    ]);
    const dry = await ran(['--dry-run']);
    expect(dry.seen).toEqual([...noKeepAssetsNotice('dry-run'), 'DEPLOY --dry-run']);
    expect(noKeepAssetsNotice('dry-run')[0]).toBe('deploy-relay: this dry run is WITHOUT --keep-assets, and a deploy run the same way:');
    expect(noKeepAssetsNotice('dry-run').join('\n')).not.toContain('Ctrl-C');
    for (const mode of ['deploy', 'dry-run'] as const) expect(noKeepAssetsNotice(mode).join('\n')).toContain('--keep-assets DIR');

    // With the option: the run lists what it keeps instead (above); the guided deploy gets the other arguments.
    expect((await ran(['--dry-run', '--keep-assets', previous])).seen).toEqual(['DEPLOY --dry-run']);
    // --check and --help deploy nothing; arguments the guided deploy refuses are its own to report.
    expect((await ran(['--check', 'https://relay.example'])).seen).toEqual(['DEPLOY --check https://relay.example']);
    expect((await ran(['--dry-run', '--check', 'https://relay.example'])).seen).toEqual(['DEPLOY --dry-run --check https://relay.example']);
    expect((await ran(['--wait', 'soon'])).seen).toEqual(['DEPLOY --wait soon']);
    const help = await ran(['--help']);
    expect(help.seen.filter((line) => line.includes('WITHOUT --keep-assets'))).toEqual([]);
  });

  it('--help shows the guided deploy\'s usage and then this option, with the way to make the folder from a tag', async () => {
    const shown: string[] = [];
    expect(await run(['--help'], { out: (line) => shown.push(line) })).toBe(0);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain('scripts/deploy-relay.sh --dry-run');
    expect(shown[1]).toBe(KEEP_ASSETS_USAGE);
    for (const part of ['--keep-assets DIR', 'git archive --prefix=previous/ vX.Y.Z', 'pnpm --filter @smurg/web build', 'index.html is always the new build']) expect(KEEP_ASSETS_USAGE).toContain(part);
  });
});
