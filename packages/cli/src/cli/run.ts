// The `smurg` command dispatcher (everything but the two entry points Claude Code runs, which main.ts dispatches
// before this module is even loaded). Each command lives in its own module and is imported only when it runs, so a
// command never pays for another one's dependencies (`smurg login` does not load the daemon).
import { m, renderText, resolveLang, type Locale } from '../i18n/index.ts';
import { EXIT } from './exit-codes.ts';
import { formatFailure, usageError } from './errors.ts';
import type { CliIo } from './io.ts';
import type { UninstallDeps } from '../commands/uninstall.ts';
import type { UpdateDeps } from '../commands/update.ts';

/** Test seams of the two commands that act on the executable itself (the real ones: process.execPath, the network). */
export interface CliDeps {
  readonly update?: UpdateDeps;
  readonly uninstall?: UninstallDeps;
}

export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  // The language of this run, decided once: SMURG_LANG, the locale, or (macOS, no locale set) the system language.
  let lang: Locale = 'en';
  try {
    lang = resolveLang(io.env, io.systemLanguages);
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout.write(renderText(lang, m('usage.root')));
        return EXIT.ok;
      case '--version':
      case '-v':
      case 'version': {
        const { versionBanner } = await import('../version.ts');
        io.stdout.write(`${versionBanner()}\n`);
        return EXIT.ok;
      }
      case 'host': {
        const [{ runHost }, { commandContext }] = await Promise.all([import('../commands/host.ts'), import('../commands/context.ts')]);
        return await runHost(rest, commandContext(io, lang));
      }
      case 'attach': {
        const [{ runAttach }, { commandContext }] = await Promise.all([import('../commands/attach.ts'), import('../commands/context.ts')]);
        return await runAttach(rest, commandContext(io, lang));
      }
      case 'stop':
      case 'status': {
        const [{ runStop, runStatus }, { commandContext }] = await Promise.all([import('../commands/stop.ts'), import('../commands/context.ts')]);
        return await (command === 'stop' ? runStop : runStatus)(rest, commandContext(io, lang));
      }
      case 'login':
      case 'logout': {
        const [{ runLogin, runLogout }, { commandContext }] = await Promise.all([import('../commands/login.ts'), import('../commands/context.ts')]);
        return await (command === 'login' ? runLogin : runLogout)(rest, commandContext(io, lang));
      }
      case 'update': {
        const [{ runUpdate }, { commandContext }] = await Promise.all([import('../commands/update.ts'), import('../commands/context.ts')]);
        return await runUpdate(rest, commandContext(io, lang), deps.update);
      }
      case 'uninstall': {
        const [{ runUninstall }, { commandContext }] = await Promise.all([import('../commands/uninstall.ts'), import('../commands/context.ts')]);
        return await runUninstall(rest, commandContext(io, lang), deps.uninstall);
      }
      case 'licenses': {
        const { runLicenses } = await import('../commands/licenses.ts');
        return runLicenses(rest, io, undefined, lang);
      }
      default:
        throw usageError(m('cli.unknownCommand', { command }), m('cli.unknownCommand.hint'));
    }
  } catch (err) {
    const failure = formatFailure(err, lang);
    io.stderr.write(failure.text);
    return failure.exitCode;
  }
}

