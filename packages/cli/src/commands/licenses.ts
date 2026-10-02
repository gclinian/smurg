// `smurg licenses [--third-party]`: smurg's own license, then the third-party notices of everything the executable
// contains (with --third-party: the notices only, byte for byte what a release publishes as THIRD-PARTY-NOTICES.txt).
// Inside the single executable both texts are SEA assets that scripts/build-sea.ts embedded at build time
// (../licenses/notices.ts); from source they are the repository's LICENSE and packages/cli/THIRD-PARTY-NOTICES.txt,
// with the Node.js section taken from the running Node's distribution when it has its LICENSE file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../cli/args.ts';
import { CliError } from '../cli/errors.ts';
import { EXIT } from '../cli/exit-codes.ts';
import type { CliIo } from '../cli/io.ts';
import { m, renderText, resolveLang, type Locale } from '../i18n/index.ts';
import { INSTALL_COMMAND } from '../update/downloads.ts';
import { composeExecutableNotices, NOTICE_ASSETS, nodeDistributionLicense } from '../licenses/notices.ts';

interface SeaAssets {
  isSea(): boolean;
  getAsset(key: string, encoding: string): string;
}

export interface LicenseTexts {
  readonly license: string;
  readonly thirdParty: string;
}

/** The two texts: the executable's embedded copies, or the repository's files when running from source. */
export function licenseTexts(): LicenseTexts {
  const sea = process.getBuiltinModule?.('node:sea') as SeaAssets | undefined;
  if (sea?.isSea()) {
    try {
      return { license: sea.getAsset(NOTICE_ASSETS.license, 'utf8'), thirdParty: sea.getAsset(NOTICE_ASSETS.thirdParty, 'utf8') };
    } catch (err) {
      throw new CliError(m('licenses.missing'), { hint: m('licenses.missing.hint', { install: INSTALL_COMMAND }), cause: err });
    }
  }
  const license = readFileSync(fileURLToPath(new URL('../../../../LICENSE', import.meta.url)), 'utf8');
  const committed = readFileSync(fileURLToPath(new URL('../../THIRD-PARTY-NOTICES.txt', import.meta.url)), 'utf8');
  const node = nodeDistributionLicense(process.execPath, process.versions.node);
  return { license, thirdParty: node === null ? committed : composeExecutableNotices(committed, node) };
}

export function runLicenses(argv: readonly string[], io: CliIo, texts: () => LicenseTexts = licenseTexts, lang: Locale = resolveLang(io.env, io.systemLanguages)): number {
  const args = parseArgs(argv, { options: { 'third-party': { kind: 'boolean' }, help: { kind: 'boolean', short: 'h' } } });
  if (args.options['help']) {
    io.stdout.write(renderText(lang, m('usage.licenses')));
    return EXIT.ok;
  }
  const { license, thirdParty } = texts();
  // `smurg licenses | head` or a pager that quits early: stop quietly instead of an EPIPE stack trace.
  const stream = io.stdout as { on?(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown };
  stream.on?.('error', (err) => io.exit(err.code === 'EPIPE' ? EXIT.ok : EXIT.failure));
  if (args.options['third-party'] === true) io.stdout.write(thirdParty);
  else io.stdout.write(`${license.endsWith('\n') ? license : `${license}\n`}\n${thirdParty}`);
  return EXIT.ok;
}
