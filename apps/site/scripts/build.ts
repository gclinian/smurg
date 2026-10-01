// Builds smurg.ai into apps/site/dist: public/ plus the pages generated from the repository (scripts/site.ts).
//
//   node apps/site/scripts/build.ts          (or: pnpm --filter @smurg/site run build)
//
// wrangler.jsonc runs it as the custom build, before `wrangler deploy` (and --dry-run), `wrangler dev` and the tests'
// local workerd: what is deployed is always built from the checkout at hand. Nothing here touches the network.
//
// Environment:
//   SMURG_SITE_THIRD_PARTY_NOTICES=<file>   publish this file as /third-party-notices.txt: for a deploy, REQUIRED, the
//                                           release's own THIRD-PARTY-NOTICES.txt (docs/RELEASING.md §4.1); it must
//                                           have its Node.js section filled in
//   SMURG_SITE_ALLOW_PLACEHOLDER=1          build even though LICENSE still says "<COPYRIGHT HOLDER>", the notices'
//                                           Node.js section is still the committed placeholder, or no notices file is
//                                           named (then the build runs `node scripts/third-party-notices.ts
//                                           --executable`: the running Node.js's LICENSE). Previews and tests only:
//                                           never for a deploy
//   SMURG_SITE_SOURCE_ROOT=<dir>            read docs/, CHANGELOG.md and LICENSE from <dir> instead (tests only)
//
// It prints every docs link it rewrote or turned into plain text, and exits 1, listing the problems, when the site
// cannot be built as it should be (scripts/site.ts generateSite).
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { DIST_DIR, REPO_ROOT, SiteError, generateSite, optionsFromEnv, writeSite } from './site.ts';

function main(): number {
  // wrangler runs this with its own working directory: refuse to build one checkout for a wrangler run in another
  // (wrangler would deploy that other checkout's dist/).
  const cwd = realpathSync(process.cwd());
  if (relative(realpathSync(REPO_ROOT), cwd).startsWith('..')) {
    console.error(`smurg.ai build: run from inside ${REPO_ROOT} (now in ${cwd}): this build writes ${DIST_DIR}.`);
    return 1;
  }
  const options = optionsFromEnv();
  if (options.repoRoot !== undefined) console.log(`smurg.ai build: docs, CHANGELOG.md and LICENSE from ${options.repoRoot} (not this repository)`);
  let site;
  try {
    site = generateSite(options);
  } catch (error) {
    if (error instanceof SiteError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const { written, removed } = writeSite(DIST_DIR, site.files);
  const section = (title: string, lines: readonly string[]): void => {
    if (lines.length > 0) console.log(`${title}:\n${lines.map((line) => `  ${line}`).join('\n')}`);
  };
  section('docs links rewritten to the site', site.rewritten);
  section('docs links turned into plain text', site.plain);
  section('raw HTML in the docs, shown as text', site.rawHtml);
  console.log(`smurg.ai: ${site.files.size} files in ${relative(REPO_ROOT, DIST_DIR)} (${written} written, ${removed} removed)`);
  return 0;
}

process.exitCode = main();
