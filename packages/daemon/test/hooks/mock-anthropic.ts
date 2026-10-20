// TEST ONLY: a scripted fake of the Anthropic Messages API on 127.0.0.1 (ported from the claude-hooks spike's
// mock-anthropic.mjs, docs/research/claude-hooks.md). The real `claude` binary talks to it through ANTHROPIC_BASE_URL
// with a dummy key, so no test ever reaches the real API or anyone's account (ARCHITECTURE §0 rule 2). It replays
// the assistant's tool calls step by step and records every request, so a test can see exactly what the model was
// told (e.g. the tool_result a PreToolUse deny produced) and which model it was asked for.
//
// DESIGN 0.6.0 D17 (measured with 2.1.288 against a fake API like this one, U1 E4, U2 §B, U4 B): auto mode's classifier
// is a side request of Claude Code's (model claude-sonnet-5, no tools, a system block that starts with
// CLASSIFIER_SYSTEM_START) in two stages: stage 1 (max_tokens 64, stop_sequences ["</severity>"]) wants
// "<severity>N"; stage 2 (when stage 1 says 50 or more, or cannot be read) wants
// "<thinking>…</thinking><severity>N</severity>" and "<category>Rule</category>" when a block rule matched. The
// `classifier` option answers both (default: severity 5, which allows); 'garbage' answers text no stage can read
// (Claude Code tries again, then blocks: "Auto mode could not evaluate this action …"). `refuseModels` answers a
// main request for such a model with HTTP 404 `not_found_error`, as the API refuses a model it does not have.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockStep {
  readonly text?: string;
  readonly tools?: readonly { readonly name: string; readonly input: Readonly<Record<string, unknown>> }[];
}

export interface RecordedRequest {
  readonly kind: 'messages' | 'count_tokens' | 'other';
  readonly method: string;
  readonly url: string;
  /** The `model` the request asked for (null: none, e.g. not a messages request). */
  readonly model: string | null;
  /** Auto mode's classifier: its stage (1 or 2); null for every other request. */
  readonly classifier: 1 | 2 | null;
  /** Requests of the main conversation carry tools (Read, Edit, Write, Bash, AskUserQuestion); side requests (titles, …) do not. */
  readonly isMain: boolean;
  readonly assistantTurns: number;
  readonly toolNames: readonly string[];
  readonly lastUser: unknown;
  readonly system: unknown;
  /** Only whether a credential header was present, never its value. */
  readonly credential: boolean;
}

export interface ToolResult {
  readonly toolUseId: string;
  readonly isError: boolean;
  readonly text: string;
}

/** The first words of the system prompt of auto mode's classifier (2.1.288; a billing header block comes before it). */
export const CLASSIFIER_SYSTEM_START = 'You are a security monitor for autonomous AI coding agents.';

/** One classifier request, as the `classifier` option sees it. */
export interface ClassifierRequest {
  readonly stage: 1 | 2;
  /** The model Claude Code asked to classify (2.1.288: claude-sonnet-5, whatever the session's model). */
  readonly model: string | null;
  /** The action under review: the transcript's last line before `</transcript>`, e.g. `{"Bash":"rm -rf build"}`. */
  readonly action: string;
  /** The whole text of the request's messages (the transcript and the stage's instruction). */
  readonly text: string;
}

/** How the classifier answers: a severity (0–100; 50 and more blocks) and, in stage 2, the rule; or text it cannot read. */
export type ClassifierAnswer = { readonly severity: number; readonly category?: string } | 'garbage';

export interface MockOptions {
  /**
   * Which step answers a request of the main kind, when it is not the script's next one: a subagent runs its own
   * conversation next to the main one (Claude Code starts it in the background), so the two cannot share one list.
   * `firstUser`: the JSON of the conversation's first user message (a subagent's holds the prompt it was given).
   * Undefined: the script's step.
   */
  readonly route?: (request: { readonly firstUser: string; readonly assistantTurns: number }) => MockStep | undefined;
  /** Auto mode's classifier (both stages). Default: severity 5, which allows. */
  readonly classifier?: (request: ClassifierRequest) => ClassifierAnswer;
  /** Models the API does not have: a main request for one gets HTTP 404 `not_found_error` (U1 E4). */
  readonly refuseModels?: readonly string[];
}

export interface MockAnthropic {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  /** Whether `text` was anywhere in the body of any request the mock received (what the "model" could have read). */
  saw(text: string): boolean;
  /** tool_result blocks the model received, in order, de-duplicated by tool_use_id. */
  toolResults(): ToolResult[];
  /** The tool_use id the mock gave the n-th scripted tool call (1-based across the run). */
  toolUseId(n: number): string;
  /** The classifier's requests, in order (each with its stage). */
  classifierRequests(): RecordedRequest[];
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

/** The texts of a system prompt (a string, or text blocks). */
function systemTexts(system: unknown): string[] {
  if (typeof system === 'string') return system.split('\n');
  return Array.isArray(system) ? (system as Json[]).map((block) => (typeof block['text'] === 'string' ? block['text'] : '')) : [];
}

/** The text blocks of a request's messages, in order. */
function messageTexts(messages: readonly Json[]): string[] {
  return messages.flatMap((message) => {
    const content = message['content'];
    if (typeof content === 'string') return [content];
    return Array.isArray(content) ? (content as Json[]).map((block) => (typeof block['text'] === 'string' ? block['text'] : '')) : [];
  });
}

/** The action under review: the text block just before the one that closes the transcript (U2: how 2.1.288 lays it out). */
function actionOf(texts: readonly string[]): string {
  const end = texts.findIndex((text) => text.trim() === '</transcript>');
  return end > 0 ? (texts[end - 1] ?? '').trim() : '';
}

function sse(res: ServerResponse, events: readonly (readonly [string, Json])[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

export async function startMockAnthropic(steps: readonly MockStep[], options: MockOptions = {}): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = [];
  const bodies: string[] = [];
  let toolSeq = 0;
  const respond = (res: ServerResponse, body: Json, content: Json[], stopped?: { readonly reason: string; readonly sequence: string }): void => {
    const stop = stopped?.reason ?? (content.some((block) => block['type'] === 'tool_use') ? 'tool_use' : 'end_turn');
    const stopSequence = stopped?.sequence ?? null;
    const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const message: Json = { id: `msg_mock_${Date.now()}`, type: 'message', role: 'assistant', model: body['model'] ?? 'claude-mock', content: [], stop_reason: null, stop_sequence: null, usage };
    if (!body['stream']) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_mock' });
      res.end(JSON.stringify({ ...message, content, stop_reason: stop, stop_sequence: stopSequence, usage: { ...usage, output_tokens: 5 } }));
      return;
    }
    const events: (readonly [string, Json])[] = [['message_start', { type: 'message_start', message }]];
    content.forEach((block, index) => {
      if (block['type'] === 'text') {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block['text'] } }]);
      } else {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block['id'], name: block['name'], input: {} } }]);
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } }]);
      }
      events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    });
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: stopSequence }, usage: { output_tokens: 5 } }]);
    events.push(['message_stop', { type: 'message_stop' }]);
    sse(res, events);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Json = {};
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        bodies.push(text);
        body = text ? (JSON.parse(text) as Json) : {};
      } catch {
        body = {};
      }
      const url = req.url ?? '';
      const credential = req.headers['x-api-key'] !== undefined || req.headers['authorization'] !== undefined;
      const model = typeof body['model'] === 'string' ? body['model'] : null;
      if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
        requests.push({ kind: 'count_tokens', method: 'POST', url, model, classifier: null, isMain: false, assistantTurns: 0, toolNames: [], lastUser: null, system: null, credential });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 42 }));
        return;
      }
      if (req.method === 'POST' && url.startsWith('/v1/messages')) {
        const tools = Array.isArray(body['tools']) ? (body['tools'] as Json[]) : [];
        const toolNames = tools.map((tool) => String(tool['name']));
        // The main conversation is the one that is offered tools (a session without Edit / Write, were there one, is
        // still it); side requests (titles, summaries) carry none of these.
        const isMain = ['Edit', 'Write', 'Read', 'Bash', 'AskUserQuestion'].some((name) => toolNames.includes(name));
        const messages = Array.isArray(body['messages']) ? (body['messages'] as Json[]) : [];
        const assistantTurns = messages.filter((m) => m['role'] === 'assistant').length;
        const lastUser = [...messages].reverse().find((m) => m['role'] === 'user') ?? null;
        const classifier = !isMain && systemTexts(body['system']).some((text) => text.trimStart().startsWith(CLASSIFIER_SYSTEM_START)) ? (Array.isArray(body['stop_sequences']) && (body['stop_sequences'] as unknown[]).includes('</severity>') ? 1 : 2) : null;
        requests.push({ kind: 'messages', method: 'POST', url, model, classifier, isMain, assistantTurns, toolNames, lastUser, system: body['system'] ?? null, credential });
        if (classifier !== null) {
          const texts = messageTexts(messages);
          const answer = options.classifier?.({ stage: classifier, model, action: actionOf(texts), text: texts.join('') }) ?? { severity: 5 };
          if (answer === 'garbage') respond(res, body, [{ type: 'text', text: 'mock side response' }]);
          else if (classifier === 1) respond(res, body, [{ type: 'text', text: `<severity>${answer.severity}` }], { reason: 'stop_sequence', sequence: '</severity>' });
          else respond(res, body, [{ type: 'text', text: `<thinking>the fake API's classifier</thinking><severity>${answer.severity}</severity>${answer.category === undefined ? '' : `<category>${answer.category}</category>`}` }]);
          return;
        }
        if (!isMain) {
          respond(res, body, [{ type: 'text', text: 'mock side response' }]);
          return;
        }
        if (model !== null && options.refuseModels?.includes(model)) {
          res.writeHead(404, { 'content-type': 'application/json', 'request-id': 'req_mock' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${model}` } }));
          return;
        }
        const firstUser = JSON.stringify(messages.find((m) => m['role'] === 'user')?.['content'] ?? '');
        const step = options.route?.({ firstUser, assistantTurns }) ?? steps[Math.min(assistantTurns, steps.length - 1)] ?? { text: 'done' };
        const content: Json[] =
          step.text !== undefined
            ? [{ type: 'text', text: step.text }]
            : (step.tools ?? []).map((tool) => ({ type: 'tool_use', id: `toolu_mock_${++toolSeq}`, name: tool.name, input: tool.input }));
        respond(res, body, content);
        return;
      }
      requests.push({ kind: 'other', method: req.method ?? '', url, model, classifier: null, isMain: false, assistantTurns: 0, toolNames: [], lastUser: null, system: null, credential });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    saw: (text: string) => bodies.some((body) => body.includes(text)),
    toolResults(): ToolResult[] {
      const out: ToolResult[] = [];
      const seen = new Set<string>();
      for (const request of requests) {
        if (request.kind !== 'messages' || !request.isMain) continue;
        const content = (request.lastUser as Json | null)?.['content'];
        if (!Array.isArray(content)) continue;
        for (const block of content as Json[]) {
          if (block['type'] !== 'tool_result') continue;
          const id = String(block['tool_use_id']);
          if (seen.has(id)) continue;
          seen.add(id);
          const inner = block['content'];
          const text = typeof inner === 'string' ? inner : Array.isArray(inner) ? (inner as Json[]).map((c) => String(c['text'] ?? '')).join('') : '';
          out.push({ toolUseId: id, isError: block['is_error'] === true, text });
        }
      }
      return out;
    },
    toolUseId: (n: number) => `toolu_mock_${n}`,
    classifierRequests: () => requests.filter((request) => request.classifier !== null),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
