// TEST ONLY: a scripted fake of the Anthropic Messages API on 127.0.0.1 (ported from the claude-hooks spike's
// mock-anthropic.mjs, docs/research/claude-hooks.md). The real `claude` binary talks to it through ANTHROPIC_BASE_URL
// with a dummy key, so no test ever reaches the real API or anyone's account (ARCHITECTURE §0 rule 2). It replays
// the assistant's tool calls step by step and records every request, so a test can see exactly what the model was
// told (e.g. the tool_result a PreToolUse deny produced).
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

export interface MockAnthropic {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  /** tool_result blocks the model received, in order, de-duplicated by tool_use_id. */
  toolResults(): ToolResult[];
  /** The tool_use id the mock gave the n-th scripted tool call (1-based across the run). */
  toolUseId(n: number): string;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

function sse(res: ServerResponse, events: readonly (readonly [string, Json])[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

export async function startMockAnthropic(steps: readonly MockStep[]): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = [];
  let toolSeq = 0;
  const respond = (res: ServerResponse, body: Json, content: Json[]): void => {
    const stop = content.some((block) => block['type'] === 'tool_use') ? 'tool_use' : 'end_turn';
    const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const message: Json = { id: `msg_mock_${Date.now()}`, type: 'message', role: 'assistant', model: body['model'] ?? 'claude-mock', content: [], stop_reason: null, stop_sequence: null, usage };
    if (!body['stream']) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_mock' });
      res.end(JSON.stringify({ ...message, content, stop_reason: stop, usage: { ...usage, output_tokens: 5 } }));
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
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }]);
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
        body = text ? (JSON.parse(text) as Json) : {};
      } catch {
        body = {};
      }
      const url = req.url ?? '';
      const credential = req.headers['x-api-key'] !== undefined || req.headers['authorization'] !== undefined;
      if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
        requests.push({ kind: 'count_tokens', method: 'POST', url, isMain: false, assistantTurns: 0, toolNames: [], lastUser: null, system: null, credential });
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
        requests.push({ kind: 'messages', method: 'POST', url, isMain, assistantTurns, toolNames, lastUser, system: body['system'] ?? null, credential });
        if (!isMain) {
          respond(res, body, [{ type: 'text', text: 'mock side response' }]);
          return;
        }
        const step = steps[Math.min(assistantTurns, steps.length - 1)] ?? { text: 'done' };
        const content: Json[] =
          step.text !== undefined
            ? [{ type: 'text', text: step.text }]
            : (step.tools ?? []).map((tool) => ({ type: 'tool_use', id: `toolu_mock_${++toolSeq}`, name: tool.name, input: tool.input }));
        respond(res, body, content);
        return;
      }
      requests.push({ kind: 'other', method: req.method ?? '', url, isMain: false, assistantTurns: 0, toolNames: [], lastUser: null, system: null, credential });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
