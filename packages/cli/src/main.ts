#!/usr/bin/env node
// Entry point of the `smurg` command. It imports NOTHING before it knows the command: `smurg hook` and `smurg mcp` run
// once per tool call / session inside Claude Code and must start fast, so they load only their own entry points
// (`@smurg/daemon/hook-cli`, `@smurg/daemon/mcp`, which never reach the daemon); every other command goes through the
// dispatcher (./cli/run.ts), which loads each command's module when it runs.
//
// Runs straight from TypeScript on Node >= 22.18 (type stripping), and unchanged inside the single executable (SEA,
// scripts/build-sea.ts), where process.argv is [exe, exe, ...args] too.

/** A command that leaves no handle behind exits by itself; this only catches a leaked handle. */
const EXIT_GRACE_MS = 3_000;

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === 'hook') {
    const { runHookCli } = await import('@smurg/daemon/hook-cli');
    return runHookCli();
  }
  if (command === 'mcp') {
    const { runMcpServer } = await import('@smurg/daemon/mcp');
    return runMcpServer();
  }
  const [{ runCli }, { processIo }] = await Promise.all([import('./cli/run.ts'), import('./cli/io.ts')]);
  return runCli(argv, processIo());
}

const args = process.argv.slice(2);
main(args).then(
  (code) => {
    process.exitCode = code;
    // hook / mcp end when their streams end; everything else should end now that the command returned.
    if (args[0] !== 'hook' && args[0] !== 'mcp') setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
  },
  (err: unknown) => {
    process.stderr.write(`smurg：發生未預期的錯誤（${err instanceof Error ? err.name : 'unknown'}）。\n`);
    process.exitCode = 1;
  },
);
