// `smurg mcp`: the coordination MCP server (stdio, server name `smurg`) Claude Code starts in every session through
// the session's --mcp-config (ARCHITECTURE §7.6, §7.7; SPEC R8). It only proxies tool calls — who_is_editing,
// lock_status, wait_for_lock, list_sessions, notify_member — to $SMURG_HOOK_SOCKET with $SMURG_SESSION_TOKEN
// (op 'mcp'); the daemon decides everything (src/hooks/mcp-tools.ts).
//
// It must start FAST and never imports the daemon (src/daemon.ts, src/index.ts, `@smurg/daemon`), zod or anything
// heavy (node-pty, srt, yjs). The CLI loads it through the package export `@smurg/daemon/mcp`
// (test/composition.test.ts checks the import graph). So the protocol is implemented here directly: MCP's stdio
// transport is newline-delimited JSON-RPC 2.0, and a tools-only server needs initialize, ping, tools/list and
// tools/call (plus notifications/cancelled). Tool failures are results with `isError: true` (the model reads them);
// protocol failures are JSON-RPC errors. Nothing but JSON-RPC is ever written to stdout.
import { randomBytes } from 'node:crypto';
import { HookSocketError, requestDaemon } from '../hooks/socket-client.ts';
import {
  HOOK_ENV,
  MCP_CALL_MARGIN_MS,
  MCP_SERVER_NAME,
  WAIT_FOR_LOCK_DEFAULT_SECONDS,
  WAIT_FOR_LOCK_MAX_SECONDS,
  isJsonObject,
  isMcpToolName,
  type JsonObject,
} from '../hooks/wire.ts';
import { MCP_TOOLS } from './tools.ts';

/** What the server talks to; injectable for tests, the process's own streams and environment by default. */
export interface McpServerIo {
  /** MCP JSON-RPC messages from Claude Code (newline-delimited); EOF ends the server. */
  readonly stdin: AsyncIterable<string | Uint8Array>;
  /** MCP JSON-RPC messages to Claude Code; nothing else may be written here. */
  readonly stdout: { write(chunk: string | Uint8Array): unknown };
  /** Diagnostics only (Claude Code logs it). */
  readonly stderr: { write(chunk: string | Uint8Array): unknown };
  /** SMURG_HOOK_SOCKET, SMURG_SESSION_TOKEN, SMURG_SESSION_ID are set by the daemon on the session. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function processIo(): McpServerIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env };
}

/** MCP revisions whose tools subset this server implements; a client asking for another one gets the newest. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_VERSION = '0.0.0';
/** Longest JSON-RPC line read from Claude Code. */
const MCP_LINE_MAX_BYTES = 4 * 1024 * 1024;
/** Deadline of the calls that do not wait. */
const MCP_CALL_DEADLINE_MS = 15_000;

const INSTRUCTIONS =
  'smurg shares this workspace with teammates and their agents. smurg blocks your Edit/Write/NotebookEdit on a file that a teammate is typing in or another agent is modifying; ' +
  'the error names who holds it. Then work on another file first, or use wait_for_lock. who_is_editing, lock_status and list_sessions show who works where; notify_member asks a person to act.';

type JsonRpcId = string | number;

const JSONRPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

class McpStdioServer {
  private readonly io: McpServerIo;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<void>>();

  constructor(io: McpServerIo) {
    this.io = io;
  }

  async run(): Promise<void> {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let discarding = false;
    for await (const chunk of this.io.stdin) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discarding) {
          discarding = false;
          continue;
        }
        this.onLine(line);
      }
      if (buffer.length > MCP_LINE_MAX_BYTES) {
        // One oversized message: answer once, skip it up to its end of line.
        buffer = '';
        discarding = true;
        this.write({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.parseError, message: 'message too large' } });
      }
    }
    if (!discarding && buffer.trim().length > 0) this.onLine(buffer);
    // Claude Code closed stdin: the session is over, nobody reads the answers any more.
    for (const controller of this.inFlight.values()) controller.abort();
    await Promise.allSettled([...this.pending]);
  }

  private write(message: JsonObject | JsonObject[]): void {
    this.io.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (text.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.parseError, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(message)) {
      // JSON-RPC batches (MCP 2025-03-26): answer each request of the batch.
      for (const item of message) this.onMessage(item);
      return;
    }
    this.onMessage(message);
  }

  private onMessage(message: unknown): void {
    if (!isJsonObject(message)) {
      this.write({ jsonrpc: '2.0', id: null, error: { code: JSONRPC.invalidRequest, message: 'Invalid Request' } });
      return;
    }
    const method = message['method'];
    const id = message['id'];
    if (typeof method !== 'string') return; // a response to nothing we sent, or junk: ignore
    if (!isId(id)) {
      this.onNotification(method, message['params']);
      return;
    }
    const params = message['params'] === undefined ? {} : message['params'];
    if (!isJsonObject(params)) {
      this.write({ jsonrpc: '2.0', id, error: { code: JSONRPC.invalidParams, message: 'params must be an object' } });
      return;
    }
    switch (method) {
      case 'initialize':
        this.write({ jsonrpc: '2.0', id, result: this.initializeResult(params) });
        return;
      case 'ping':
        this.write({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        this.write({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
        return;
      case 'tools/call': {
        const task = this.callTool(id, params);
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task));
        return;
      }
      default:
        this.write({ jsonrpc: '2.0', id, error: { code: JSONRPC.methodNotFound, message: `Method not found: ${method.slice(0, 64)}` } });
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'notifications/cancelled' && isJsonObject(params) && isId(params['requestId'])) {
      this.inFlight.get(String(params['requestId']))?.abort();
    }
    // notifications/initialized and everything else need no action.
  }

  private initializeResult(params: JsonObject): JsonObject {
    const requested = params['protocolVersion'];
    const protocolVersion = typeof requested === 'string' && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, title: 'smurg workspace coordination', version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    };
  }

  private async callTool(id: JsonRpcId, params: JsonObject): Promise<void> {
    const name = params['name'];
    if (!isMcpToolName(name)) {
      this.write({ jsonrpc: '2.0', id, error: { code: JSONRPC.invalidParams, message: `Unknown tool: ${String(name).slice(0, 64)}` } });
      return;
    }
    const args = params['arguments'] === undefined ? {} : params['arguments'];
    if (!isJsonObject(args)) {
      this.write({ jsonrpc: '2.0', id, error: { code: JSONRPC.invalidParams, message: 'arguments must be an object' } });
      return;
    }
    const key = String(id);
    const controller = new AbortController();
    this.inFlight.get(key)?.abort();
    this.inFlight.set(key, controller);
    try {
      const waitSeconds = typeof args['timeout_seconds'] === 'number' ? Math.min(Math.max(args['timeout_seconds'], 1), WAIT_FOR_LOCK_MAX_SECONDS) : WAIT_FOR_LOCK_DEFAULT_SECONDS;
      const deadlineMs = name === 'wait_for_lock' ? waitSeconds * 1000 + MCP_CALL_MARGIN_MS : MCP_CALL_DEADLINE_MS;
      const requestId = randomBytes(12).toString('base64url');
      const reply = await requestDaemon(
        this.io.env[HOOK_ENV.socket] ?? '',
        { id: requestId, token: this.io.env[HOOK_ENV.token] ?? '', op: 'mcp', tool: name, args },
        { deadlineMs, signal: controller.signal },
      );
      if (reply['id'] !== requestId || typeof reply['ok'] !== 'boolean') throw new HookSocketError('malformed', 'malformed daemon reply');
      if (reply['ok'] === true) {
        this.write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(reply['result'] ?? null, null, 2) }], isError: false } });
      } else {
        const error = isJsonObject(reply['error']) ? reply['error'] : {};
        const message = typeof error['message'] === 'string' ? error['message'] : 'The smurg daemon refused this call.';
        const code = typeof error['code'] === 'string' ? error['code'] : 'error';
        this.write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `smurg (${code}): ${message}` }], isError: true } });
      }
    } catch (err) {
      if (controller.signal.aborted) return; // cancelled: MCP says not to answer
      const detail = err instanceof HookSocketError ? `${err.kind}: ${err.message}` : 'error';
      this.io.stderr.write(`smurg mcp: ${name}: ${detail}\n`);
      this.write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `smurg: the workspace daemon is unreachable (${detail}). Lock information is unavailable; smurg will still block edits to files that others hold.` }], isError: true },
      });
    } finally {
      if (this.inFlight.get(key) === controller) this.inFlight.delete(key);
    }
  }
}

/** Serves MCP on `io` until stdin ends and resolves with the process exit code (the CLI sets process.exitCode). */
export async function runMcpServer(io: McpServerIo = processIo()): Promise<number> {
  try {
    await new McpStdioServer(io).run();
    return 0;
  } catch (err) {
    io.stderr.write(`smurg mcp: ${err instanceof Error ? err.message : 'failed'}\n`);
    return 1;
  }
}
