// PURE (ARCHITECTURE §7.6 "Normalised events"; DESIGN §2.3, AD-2): one line Claude Code printed on stdout → what it
// means for the runner (RunnerEvent). The wire never carries Claude Code's own shapes: the runner turns these into
// conversation events, cards and bus events. Everything not listed in DESIGN §2.3 is ignored; a line that is not a
// JSON object is reported once per session by the caller (`unparsed`).
//
// The only state is which Anthropic message is streaming per (sub)agent, so the text deltas of a block and the
// finished block that replaces them get the same key.
import type { TurnOutcome } from '@smurg/protocol';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export type RunnerEvent =
  | { readonly kind: 'control.response'; readonly requestId: string; readonly ok: boolean; readonly response: unknown; readonly error?: string }
  | {
      readonly kind: 'init';
      readonly claudeSessionId: string;
      readonly version: string;
      readonly tools: readonly string[];
      readonly permissionMode?: string;
      readonly apiKeySource?: string;
    }
  /** Text of a block that is streaming. `blockKey`: the same key its finished `text` has. */
  | { readonly kind: 'delta'; readonly blockKey: string; readonly text: string; readonly parentToolUseId?: string }
  | { readonly kind: 'thinking'; readonly blockKey: string; readonly parentToolUseId?: string }
  | { readonly kind: 'text'; readonly blockKey: string; readonly text: string; readonly aborted: boolean; readonly synthetic: boolean; readonly parentToolUseId?: string }
  | { readonly kind: 'tool.use'; readonly toolUseId: string; readonly name: string; readonly input: unknown; readonly parentToolUseId?: string }
  | { readonly kind: 'tool.result'; readonly toolUseId: string; readonly ok: boolean; readonly text: string; readonly structured: unknown }
  /** Claude Code echoed our own message: a turn took it. */
  | { readonly kind: 'replay'; readonly uuid: string }
  | { readonly kind: 'lifecycle'; readonly uuid: string; readonly state: 'queued' | 'started' | 'completed' | 'cancelled' }
  | {
      readonly kind: 'request';
      readonly requestId: string;
      readonly toolName: string;
      readonly toolUseId: string;
      readonly input: unknown;
      readonly reason?: string;
      readonly reasonType?: string;
      readonly blockedPath?: string;
      readonly suggestions: unknown;
    }
  /** A control request of a subtype smurg does not serve: answered with an error at once (the CLI must not wait). */
  | { readonly kind: 'request.unsupported'; readonly requestId: string; readonly subtype: string }
  | { readonly kind: 'request.cancelled'; readonly requestId: string }
  | { readonly kind: 'api.retry'; readonly error: string; readonly attempt: number; readonly max: number; readonly auth: boolean }
  | { readonly kind: 'rate.limit'; readonly allowed: boolean; readonly resetsAt?: number }
  | { readonly kind: 'status'; readonly compacting?: boolean; readonly permissionMode?: string }
  | { readonly kind: 'compact.boundary' }
  | { readonly kind: 'result'; readonly outcome: TurnOutcome; readonly durationMs: number; readonly uuids: readonly string[]; readonly apiError: boolean };

const LIFECYCLE_STATES = new Set(['queued', 'started', 'completed', 'cancelled']);

/** `result` → the turn's outcome (subtype and terminal_reason; runtime/HANDOVER.md "The protocol"). */
export function outcomeOfResult(message: Json): TurnOutcome {
  const subtype = str(message['subtype']);
  const terminal = str(message['terminal_reason']) ?? '';
  if (subtype === 'error_max_turns') return 'max-turns';
  if (subtype === 'error_max_budget_usd') return 'budget';
  if (terminal.startsWith('aborted')) return 'interrupted';
  if (subtype === 'success') return message['is_error'] === true ? 'error' : terminal !== '' && terminal !== 'completed' ? 'interrupted' : 'completed';
  return 'error';
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isObject(part) ? (str(part['text']) ?? (typeof part['type'] === 'string' ? `[${part['type']}]` : '')) : '')).join('');
}

export class Normaliser {
  /** The Anthropic message streaming right now, per (sub)agent ('' is the main conversation). */
  private readonly streaming = new Map<string, string>();
  /** Finished blocks seen per Anthropic message id (an `assistant` line carries ONE finished block). */
  private readonly finished = new Map<string, number>();

  /** A turn ended: forget the per-message counters (ids never repeat across turns). */
  reset(): void {
    this.streaming.clear();
    this.finished.clear();
  }

  /** Parses one stdout line; null when it is not a JSON object. */
  static parse(line: string): Json | null {
    try {
      const value: unknown = JSON.parse(line);
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }

  normalise(message: Json): RunnerEvent[] {
    const parent = str(message['parent_tool_use_id']);
    const withParent = parent === undefined ? {} : { parentToolUseId: parent };
    switch (message['type']) {
      case 'control_response': {
        const response = isObject(message['response']) ? message['response'] : {};
        const requestId = str(response['request_id']);
        if (requestId === undefined) return [];
        const ok = response['subtype'] === 'success';
        return [{ kind: 'control.response', requestId, ok, response: response['response'] ?? {}, ...(ok ? {} : { error: str(response['error']) ?? 'control request failed' }) }];
      }
      case 'control_request': {
        const requestId = str(message['request_id']);
        const request = isObject(message['request']) ? message['request'] : {};
        if (requestId === undefined) return [];
        const subtype = str(request['subtype']) ?? 'unknown';
        if (subtype !== 'can_use_tool') return [{ kind: 'request.unsupported', requestId, subtype: subtype.slice(0, 64) }];
        const reason = str(request['decision_reason']);
        const reasonType = str(request['decision_reason_type']);
        const blockedPath = str(request['blocked_path']);
        return [
          {
            kind: 'request',
            requestId,
            toolName: str(request['tool_name']) ?? '',
            toolUseId: str(request['tool_use_id']) ?? '',
            input: request['input'],
            ...(reason === undefined ? {} : { reason }),
            ...(reasonType === undefined ? {} : { reasonType }),
            ...(blockedPath === undefined ? {} : { blockedPath }),
            suggestions: request['permission_suggestions'],
          },
        ];
      }
      case 'control_cancel_request': {
        const requestId = str(message['request_id']);
        return requestId === undefined ? [] : [{ kind: 'request.cancelled', requestId }];
      }
      case 'system':
        return this.system(message);
      case 'command_lifecycle': {
        const uuid = str(message['command_uuid']);
        const state = str(message['state']);
        if (uuid === undefined || state === undefined || !LIFECYCLE_STATES.has(state)) return [];
        return [{ kind: 'lifecycle', uuid, state: state as 'queued' | 'started' | 'completed' | 'cancelled' }];
      }
      case 'stream_event': {
        const event = isObject(message['event']) ? message['event'] : {};
        const lane = parent ?? '';
        if (event['type'] === 'message_start') {
          const id = isObject(event['message']) ? str(event['message']['id']) : undefined;
          if (id !== undefined) this.streaming.set(lane, id);
          return [];
        }
        if (event['type'] !== 'content_block_delta' || !isObject(event['delta'])) return [];
        const messageId = this.streaming.get(lane);
        const index = num(event['index']);
        if (messageId === undefined || index === undefined) return [];
        const blockKey = `${messageId}:${index}`;
        if (event['delta']['type'] === 'text_delta') {
          const text = str(event['delta']['text']);
          return text === undefined || text.length === 0 ? [] : [{ kind: 'delta', blockKey, text, ...withParent }];
        }
        if (event['delta']['type'] === 'thinking_delta') return [{ kind: 'thinking', blockKey, ...withParent }];
        return [];
      }
      case 'assistant': {
        const inner = isObject(message['message']) ? message['message'] : {};
        const id = str(inner['id']) ?? 'unknown';
        const synthetic = inner['model'] === '<synthetic>';
        const out: RunnerEvent[] = [];
        for (const block of Array.isArray(inner['content']) ? inner['content'] : []) {
          if (!isObject(block)) continue;
          const index = this.finished.get(id) ?? 0;
          this.finished.set(id, index + 1);
          const blockKey = `${id}:${index}`;
          if (block['type'] === 'text') {
            out.push({ kind: 'text', blockKey, text: str(block['text']) ?? '', aborted: message['aborted'] === true, synthetic, ...withParent });
          } else if (block['type'] === 'tool_use') {
            const toolUseId = str(block['id']);
            if (toolUseId !== undefined) out.push({ kind: 'tool.use', toolUseId, name: str(block['name']) ?? '', input: block['input'], ...withParent });
          }
          // thinking blocks: nothing is stored.
        }
        return out;
      }
      case 'user': {
        const uuid = str(message['uuid']);
        if (message['isReplay'] === true) return uuid === undefined ? [] : [{ kind: 'replay', uuid }];
        const inner = isObject(message['message']) ? message['message'] : {};
        const out: RunnerEvent[] = [];
        for (const block of Array.isArray(inner['content']) ? inner['content'] : []) {
          if (!isObject(block) || block['type'] !== 'tool_result') continue;
          const toolUseId = str(block['tool_use_id']);
          if (toolUseId === undefined) continue;
          out.push({ kind: 'tool.result', toolUseId, ok: block['is_error'] !== true, text: textOfContent(block['content']), structured: message['tool_use_result'] });
        }
        return out;
      }
      case 'rate_limit_event': {
        const info = isObject(message['rate_limit_info']) ? message['rate_limit_info'] : {};
        const status = str(info['status']) ?? '';
        const resets = num(info['resetsAt']);
        // Claude Code reports the reset as epoch SECONDS.
        return [{ kind: 'rate.limit', allowed: status.startsWith('allowed'), ...(resets === undefined || resets <= 0 ? {} : { resetsAt: Math.round(resets < 1e11 ? resets * 1000 : resets) }) }];
      }
      case 'result': {
        const uuids = Array.isArray(message['user_message_uuids']) ? message['user_message_uuids'].filter((entry): entry is string => typeof entry === 'string') : [];
        return [
          {
            kind: 'result',
            outcome: outcomeOfResult(message),
            durationMs: Math.max(0, Math.round(num(message['duration_ms']) ?? 0)),
            uuids,
            apiError: message['terminal_reason'] === 'api_error',
          },
        ];
      }
      default:
        return []; // unknown types are ignored on purpose: Claude Code adds new ones between versions
    }
  }

  private system(message: Json): RunnerEvent[] {
    switch (message['subtype']) {
      case 'init': {
        const tools = Array.isArray(message['tools']) ? message['tools'].filter((tool): tool is string => typeof tool === 'string') : [];
        const permissionMode = str(message['permissionMode']);
        const apiKeySource = str(message['apiKeySource']);
        return [
          {
            kind: 'init',
            claudeSessionId: str(message['session_id']) ?? '',
            version: str(message['claude_code_version']) ?? '',
            tools,
            ...(permissionMode === undefined ? {} : { permissionMode }),
            ...(apiKeySource === undefined ? {} : { apiKeySource }),
          },
        ];
      }
      case 'status': {
        const permissionMode = str(message['permissionMode']);
        const compacting = message['status'] === 'compacting';
        if (!compacting && permissionMode === undefined) return [];
        return [{ kind: 'status', ...(compacting ? { compacting: true } : {}), ...(permissionMode === undefined ? {} : { permissionMode }) }];
      }
      case 'compact_boundary':
        return [{ kind: 'compact.boundary' }];
      case 'api_retry': {
        const error = (str(message['error']) ?? 'error').slice(0, 64);
        return [{ kind: 'api.retry', error, attempt: Math.max(0, Math.trunc(num(message['attempt']) ?? 0)), max: Math.max(0, Math.trunc(num(message['max_retries']) ?? 0)), auth: error === 'authentication_failed' }];
      }
      default:
        return [];
    }
  }
}
