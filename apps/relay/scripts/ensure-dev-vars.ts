// `pnpm dev:relay` needs RELAY_SIGNING_KEY. When apps/relay/.dev.vars does not exist, this creates it (mode 0600,
// gitignored) with a freshly generated development key, so the dev server works out of the box. An existing file is
// never touched. The key is not printed.
//   node scripts/ensure-dev-vars.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSigningKey } from './signing-key.ts';

export const DEV_VARS = fileURLToPath(new URL('../.dev.vars', import.meta.url));

export async function ensureDevVars(path: string = DEV_VARS): Promise<boolean> {
  const content = `# Local secrets for \`pnpm dev:relay\` (created by scripts/ensure-dev-vars.ts). Never commit this file.
# See .dev.vars.example for the optional OAuth settings.
RELAY_SIGNING_KEY=${await generateSigningKey()}
`;
  try {
    // 'wx': fail instead of overwriting when the file appeared meanwhile.
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && (await ensureDevVars())) {
  console.log('ensure-dev-vars: created apps/relay/.dev.vars with a fresh development signing key');
}
