// Row G10 of the tool gate ON THE HOOK SOCKET (review R3-03): the real hook server, asked as `smurg hook` asks it,
// with a real folder on disk. The pure reading of a command is bash-guard.test.ts; here: the answer is "ask" (never a
// refusal, never an allowance), only where the root has recorded scripts, and the places a command names are judged
// as the FILE SYSTEM has them (a link, the root under another spelling, a path from outside).
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, rootRefKey, type RootRef } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import type { ProjectTrust } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { BASH_ASK_REASONS } from '../../src/hooks/deny-text.ts';
import { runHookCli } from '../../src/hooks/hook-cli.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { HOOK_COMMAND_FORWARD_MAX_BYTES, projectHookInput, type JsonObject } from '../../src/hooks/wire.ts';
import { TEST_HOST_USER, createTestDaemon, type TestDaemon } from '../../src/testing/index.ts';
import { fakeServices } from './fakes.ts';
import { hookRequest, registerAgent } from './helpers.ts';

let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const HOST = { userId: TEST_HOST_USER, name: 'Host' };

async function setup(): Promise<{ hooks: HookServerImpl; root: string; recorded: Map<string, Set<string>>; ask(command: string | null, extra?: JsonObject): Promise<string | null>; token: string }> {
  const recorded = new Map<string, Set<string>>();
  const trust = { protectedPaths: (root: RootRef) => recorded.get(rootRefKey(root)) ?? new Set<string>() } as unknown as ProjectTrust;
  const trustModule: FeatureModule = { name: 'fake-trust', create: () => ({ projectTrust: trust }), register: () => toDisposable(() => {}) };
  t = await createTestDaemon({
    modules: [fakeServices().module, trustModule, hooksModule],
    project: { files: { 'README.md': '#\n', 'scripts/lint.sh': '#!/bin/sh\nexit 0\n', 's3/lint.sh': '#!/bin/sh\n# staged\n', 'src/app.ts': 'export {};\n' } },
  });
  await t.connectHost();
  const hooks = t.ctx.services.hooks;
  if (!(hooks instanceof HookServerImpl)) throw new Error('the hooks slot is not the HookServerImpl');
  const { token } = registerAgent(hooks, HOST);
  const root = t.root;
  let seq = 0;
  /** What the gate hook forwards for a Bash PreToolUse of this command (null: a command too long to forward). The verdict, or null for "no output". */
  const ask = async (command: string | null, extra: JsonObject = {}): Promise<string | null> => {
    const raw = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_${++seq}`, cwd: root, tool_input: { command: command ?? `echo ${'x'.repeat(HOOK_COMMAND_FORWARD_MAX_BYTES)}`, description: 'run' }, ...extra };
    const reply = await hookRequest(hooks.socketPath, token, projectHookInput(raw, { command: true }));
    const output = reply['hookOutput'] as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null;
    if (output === null) return null;
    expect(output.hookSpecificOutput?.permissionDecision).toBe('ask');
    const reason = output.hookSpecificOutput?.permissionDecisionReason;
    return reason === BASH_ASK_REASONS.writes ? 'writes' : reason === BASH_ASK_REASONS.unsure ? 'unsure' : `? ${String(reason)}`;
  };
  return { hooks, root, recorded, ask, token };
}

describe('a shell command and the scripts the project settings run, on the hook socket (tool gate G10)', () => {
  it('nothing is asked in a root without recorded scripts; with them, a command that writes where one is asks a person, and the answer is never a refusal', async () => {
    const s = await setup();
    // No script is recorded: the gate has nothing to say about a shell command.
    for (const command of ['cp s3/lint.sh scripts/', 'mv scripts scripts.old', 'rm -rf "$X"', null]) expect(await s.ask(command), String(command)).toBeNull();
    s.recorded.set(rootRefKey(MAIN_ROOT), new Set(['scripts/lint.sh']));
    for (const command of ['cp s3/lint.sh scripts/', 'mv s3/lint.sh scripts/', 'mv scripts scripts.old', 'mv s3 scripts', "printf x > scripts/lint.sh", 'printf x | tee scripts/lint.sh', "sed -i '' 's/0/1/' scripts/lint.sh", 'ln -s scripts/lint.sh alias.sh', 'rm scripts/lint.sh', 'printf x > ./scripts/../SCRIPTS/Lint.sh']) expect(await s.ask(command), command).toBe('writes');
    for (const command of ['cp s3/lint.sh "$DEST"', 'cd "$D" && rm lint.sh', 'sh scripts/lint.sh', 'git checkout -- scripts']) expect(await s.ask(command), command).toBe('unsure');
    for (const command of ['echo beside > scripts/other.txt', 'cat scripts/lint.sh', 'cp README.md s3/', 'rm -rf dist', 'npm test', 'git add . && git commit -m "x"']) expect(await s.ask(command), command).toBeNull();
    // A command too long to forward whole is not read: a person is asked. One the hook did not forward at all: too.
    expect(await s.ask(null)).toBe('unsure');
    const bare = await hookRequest(s.hooks.socketPath, s.token, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_bare', cwd: s.root, tool_input: {} });
    expect((bare['hookOutput'] as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe('ask');
    // Other tools are not this row's business.
    const read = await hookRequest(s.hooks.socketPath, s.token, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_read', cwd: s.root, tool_input: { file_path: join(s.root, 'scripts/lint.sh') } });
    expect(read['hookOutput']).toBeNull();
  });

  it('the places are judged as the file system has them: through a link, from another directory, by the root\'s other spelling, from outside', async () => {
    const s = await setup();
    s.recorded.set(rootRefKey(MAIN_ROOT), new Set(['scripts/lint.sh', 'dist/hooks/check.js']));
    await symlink('scripts', join(s.root, 'tools'));
    await symlink(join(s.root, 'scripts', 'lint.sh'), join(s.root, 'alias.sh'));
    await mkdir(join(s.root, 'elsewhere'));
    await symlink(tmpdir(), join(s.root, 'out'));
    // A folder link and a file link that lead to the script.
    expect(await s.ask('cp s3/lint.sh tools/')).toBe('writes');
    expect(await s.ask('printf x > alias.sh')).toBe('writes');
    expect(await s.ask('printf x > tools/lint.sh')).toBe('writes');
    // Where Claude Code says the command starts.
    expect(await s.ask('rm lint.sh', { cwd: join(s.root, 'scripts') })).toBe('writes');
    expect(await s.ask('rm lint.sh', { cwd: join(s.root, 'elsewhere') })).toBeNull();
    expect(await s.ask('cd ../scripts && rm lint.sh', { cwd: join(s.root, 'elsewhere') })).toBe('writes');
    // The root spelled as it is not stored (macOS: /var → /private/var; the test root is a real path, so go through a link).
    const other = join(s.root, 'elsewhere', 'root-again');
    await symlink(s.root, other);
    expect(await s.ask(`cp x ${other}/scripts/lint.sh`, { cwd: tmpdir() })).toBe('writes');
    expect(await realpath(other)).toBe(await realpath(s.root));
    // A path that is named and not there yet, and the folders that would hold it.
    expect(await s.ask('mkdir -p dist/hooks')).toBe('writes');
    expect(await s.ask('cp x.js dist/hooks/check.js')).toBe('writes');
    // A link that leads OUT of the root is outside it: nothing of this root is there.
    expect(await s.ask('cp s3/lint.sh out/scripts/')).toBeNull();
    // A link that loops: where it leads cannot be known.
    await symlink('loop', join(s.root, 'loop'));
    expect(await s.ask('cp s3/lint.sh loop/x')).toBe('unsure');
  });

  it('the gate hook forwards the command of a Bash PreToolUse whole or not at all, and only that; the Bash activity hook forwards none', async () => {
    const input = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd', timeout: 5 } });
    expect(projectHookInput(input('ls -la'), { command: true })['tool_input']).toEqual({ command: 'ls -la' });
    expect(projectHookInput(input('ls -la'))['tool_input']).toEqual({});
    expect(projectHookInput({ ...input('ls'), hook_event_name: 'PostToolUse' }, { command: true })['tool_input']).toEqual({});
    expect(projectHookInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/a', content: 'secret', command: 'x' } }, { command: true })['tool_input']).toEqual({ file_path: '/a' });
    const long = 'x'.repeat(HOOK_COMMAND_FORWARD_MAX_BYTES);
    expect(projectHookInput(input(long), { command: true })['tool_input']).toEqual({ command_omitted: true });
    expect(projectHookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 7 } }, { command: true })['tool_input']).toEqual({ command_omitted: true });

    // End to end through the real `smurg hook` process code: stdin in, the "ask" JSON out.
    const s = await setup();
    s.recorded.set(rootRefKey(MAIN_ROOT), new Set(['scripts/lint.sh']));
    const run = async (command: string): Promise<string> => {
      let out = '';
      const code = await runHookCli({
        stdin: (async function* () {
          yield JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_cli', cwd: s.root, tool_input: { command, description: 'run' } });
        })(),
        stdout: { write: (chunk: string | Uint8Array) => void (out += String(chunk)) },
        stderr: { write: () => undefined },
        env: { SMURG_HOOK_SOCKET: s.hooks.socketPath, SMURG_SESSION_TOKEN: s.token },
        args: [],
      });
      expect(code).toBe(0);
      return out;
    };
    expect(JSON.parse(await run('mv s3 scripts'))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: BASH_ASK_REASONS.writes } });
    expect(await run('npm test')).toBe('');
  });
});
