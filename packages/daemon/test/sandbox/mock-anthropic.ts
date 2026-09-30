// TEST ONLY. A local stand-in for the Anthropic Messages API (ported from docs/research/claude-hooks.md and the
// sandbox spike's verify-write-tool.ts). The real `claude` binary is pointed at it with ANTHROPIC_BASE_URL and a dummy
// key, so no request ever reaches Anthropic and no account is involved. It answers every tool-enabled request with the
// next scripted tool call, records the tool_result that came back for the previous one, and keeps every request body
// so a test can inspect what the model would have seen (system prompt and messages).
import { createServer, type Server } from 'node:http';

export interface ScriptedToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly tool: string;
  readonly isError: boolean;
  readonly text: string;
}

export interface MockAnthropic {
  readonly port: number;
  readonly baseUrl: string;
  /** Every /v1/messages request body, in order. */
  readonly requests: readonly Record<string, unknown>[];
  /** tool_result of script step i at index i. */
  readonly toolResults: readonly ToolResult[];
  /** Everything the model was sent (system + messages of every request), as one string. */
  seenText(): string;
  close(): Promise<void>;
}

type Block = Record<string, unknown>;

function sse(events: readonly (readonly [string, unknown])[]): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function textOf(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export async function startMockAnthropic(script: readonly ScriptedToolCall[]): Promise<MockAnthropic> {
  const requests: Record<string, unknown>[] = [];
  const toolResults: ToolResult[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method !== 'POST' || !url.startsWith('/v1/messages') || url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(url.includes('count_tokens') ? '{"input_tokens":1}' : '{}');
        return;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400).end();
        return;
      }
      requests.push(json);
      const tools = Array.isArray(json['tools']) ? (json['tools'] as Block[]) : [];
      const hasTools = tools.some((tool) => tool['name'] === 'Write');
      const messages = Array.isArray(json['messages']) ? (json['messages'] as Block[]) : [];
      const results = messages.flatMap((m) => (Array.isArray(m['content']) ? (m['content'] as Block[]) : [])).filter((b) => b['type'] === 'tool_result');
      if (hasTools && results.length > toolResults.length) {
        const last = results[results.length - 1] as Block;
        toolResults.push({ tool: script[results.length - 1]?.name ?? '?', isError: last['is_error'] === true, text: textOf(last['content']).slice(0, 600) });
      }
      let block: Block;
      let stop: string;
      if (hasTools && results.length < script.length) {
        const step = script[results.length] as ScriptedToolCall;
        block = { type: 'tool_use', id: `toolu_mock_${results.length}`, name: step.name, input: step.input };
        stop = 'tool_use';
      } else {
        block = { type: 'text', text: 'done' };
        stop = 'end_turn';
      }
      const message = { id: `msg_mock_${requests.length}`, type: 'message', role: 'assistant', model: json['model'], content: [] as Block[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (json['stream'] !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop }));
        return;
      }
      const start = block['type'] === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
      const delta = block['type'] === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } : { type: 'text_delta', text: block['text'] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(
        sse([
          ['message_start', { type: 'message_start', message }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }],
        ]),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    toolResults,
    seenText: () => requests.map((r) => JSON.stringify({ system: r['system'], messages: r['messages'] })).join('\n'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
