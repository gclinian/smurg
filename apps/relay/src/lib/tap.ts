// TEST-ONLY byte tap for the R3 acceptance test (ARCHITECTURE §6). When RELAY_TAP_URL names a collector on this
// machine (config.tapTarget), the Worker posts the request line and headers of every request, and the Durable Objects
// post every WebSocket frame they receive or send, verbatim. Production keeps RELAY_TAP_URL empty; any non-local URL
// disables the tap.

export type TapSource = 'worker' | 'WorkspaceDO' | 'TransferDO';
export type TapDirection = 'in' | 'out' | 'request';
export type TapRole = 'host' | 'client' | 'none';
export type TapKind = 'text' | 'binary' | 'request';

export type TapMeta = {
  source: TapSource;
  direction: TapDirection;
  role: TapRole;
  /** Connection id the frame belongs to (0 when not applicable). */
  conn: number;
  kind: TapKind;
  workspaceId: string;
  /** Per-sender counter; resets when a Durable Object is re-created after hibernation. */
  seq: number;
};

/** Header names shared with the collector in test-support/tap-collector.ts. */
export const TAP_HEADERS = {
  source: 'x-tap-source',
  direction: 'x-tap-direction',
  role: 'x-tap-role',
  conn: 'x-tap-conn',
  kind: 'x-tap-kind',
  workspaceId: 'x-tap-workspace',
  seq: 'x-tap-seq',
  at: 'x-tap-at',
} as const;

/** Fire-and-forget: a slow or absent collector must never affect forwarding. `body` must not be reused later. */
export function postTap(url: string, meta: TapMeta, body: string | Uint8Array<ArrayBuffer>): Promise<void> {
  return fetch(url, {
    method: 'POST',
    headers: {
      [TAP_HEADERS.source]: meta.source,
      [TAP_HEADERS.direction]: meta.direction,
      [TAP_HEADERS.role]: meta.role,
      [TAP_HEADERS.conn]: String(meta.conn),
      [TAP_HEADERS.kind]: meta.kind,
      [TAP_HEADERS.workspaceId]: meta.workspaceId,
      [TAP_HEADERS.seq]: String(meta.seq),
      [TAP_HEADERS.at]: String(Date.now()),
      'content-type': 'application/octet-stream',
    },
    body,
  }).then(
    async (res) => {
      // Drain the body so the connection can be reused.
      await res.arrayBuffer().catch(() => undefined);
    },
    () => undefined,
  );
}
