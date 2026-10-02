// The dependency-free half of the hook protocol (src/hooks/wire.ts): what the hook forwards and what it prints.
import { NOTIFY_TEXT_MAX_CHARS } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { hookInputSchema } from '../../src/hooks/schemas.ts';
import {
  EDIT_TOOL_MATCHER,
  HOOK_CLI_DEADLINE_MS,
  HOOK_COMMAND_TIMEOUT_SECONDS,
  HOOK_SERVER_DECISION_MS,
  NOTIFY_MESSAGE_MAX_CHARS,
  preToolUseDeny,
  projectHookInput,
  sniffHookEventName,
} from '../../src/hooks/wire.ts';
import { daemonUnreachableReason } from '../../src/hooks/deny-text.ts';

describe('hook wire helpers', () => {
  it('deadlines nest: the daemon decides before the hook gives up, the hook gives up before Claude Code times it out', () => {
    expect(HOOK_SERVER_DECISION_MS).toBeLessThan(HOOK_CLI_DEADLINE_MS);
    expect(HOOK_CLI_DEADLINE_MS).toBeLessThan(HOOK_COMMAND_TIMEOUT_SECONDS * 1000);
  });

  it('the only decision is a deny; the unreachable reason names the daemon and reads on its own', () => {
    expect(preToolUseDeny('x')).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } });
    const reason = daemonUnreachableReason('connect: ENOENT\u0007\n');
    expect(reason).toContain('smurg daemon unreachable (connect: ENOENT');
    expect(reason).not.toMatch(/[\u0000-\u001f]/);
  });

  it('projects the hook input: paths and names only, never contents, prompts or transcripts; the daemon schema accepts the projection', () => {
    const projected = projectHookInput({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      transcript_path: '/secret/transcript.jsonl',
      cwd: '/p',
      prompt: 'the user prompt',
      tool_name: 'Write',
      tool_input: { file_path: '/p/a.txt', content: 'FILE CONTENT' },
      tool_response: { content: 'FILE CONTENT', originalFile: 'OLD' },
      tool_use_id: 't',
      permission_mode: 'default',
      stop_hook_active: false,
    });
    expect(projected).toEqual({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p', tool_name: 'Write', tool_use_id: 't', permission_mode: 'default', tool_input: { file_path: '/p/a.txt' }, stop_hook_active: false });
    expect(hookInputSchema.safeParse(projected).success).toBe(true);
    expect(projectHookInput({ hook_event_name: 'FileChanged', file_path: '/p/b', event: 'add' })).toEqual({ hook_event_name: 'FileChanged', file_path: '/p/b', event: 'add' });
    expect(projectHookInput('nonsense')).toEqual({});
  });

  it('recognises the event of an input it cannot parse', () => {
    expect(sniffHookEventName('{"session_id":"x","hook_event_name": "Stop","tool_response":{"content":"')).toBe('Stop');
    expect(sniffHookEventName('garbage')).toBeNull();
  });

  it('the edit matcher is the exact-name list of the edit tools; the notify limit equals the protocol limit', () => {
    expect(EDIT_TOOL_MATCHER).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(NOTIFY_MESSAGE_MAX_CHARS).toBe(NOTIFY_TEXT_MAX_CHARS);
  });
});
