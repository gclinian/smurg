// TEST ONLY: a local HTTP server standing in for https://downloads.smurg.ai (latest/VERSION, v<X.Y.Z>/SHA256SUMS and
// the executables), on 127.0.0.1, so no test of `smurg update` or of `smurg host`'s update notice reaches the network.
// The "executables" are tiny shell scripts that carry a build marker and answer `--version` as a release would.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Route = string | Buffer | ((req: IncomingMessage, res: ServerResponse) => void);

export interface DownloadsServer {
  /** `http://127.0.0.1:<port>`: the value of SMURG_INSTALL_BASE_URL. */
  readonly base: string;
  /** Every request path, in order. */
  readonly requests: string[];
  /** path (without the leading slash) → what is served; a missing path is a 404. Tests may change it while it runs. */
  readonly routes: Record<string, Route>;
  close(): Promise<void>;
}

export async function startDownloads(routes: Record<string, Route> = {}): Promise<DownloadsServer> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').replace(/^\//, '');
    requests.push(path);
    const route = routes[path];
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    if (typeof route === 'function') {
      route(req, res);
      return;
    }
    const body = typeof route === 'string' ? Buffer.from(route) : route;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) }).end(body);
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    routes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** The release asset name of the machine the tests run on. */
export const HOST_TARGET = `smurg-${process.platform}-${process.arch}`;

/**
 * A stand-in executable of `version`: carries the build marker (as scripts/build-sea.ts writes it) and prints a
 * version line. `says` is the version `--version` reports (default: `version`).
 */
export function fakeExecutable(version: string, says = version): string {
  return `#!/bin/sh\n# smurg-build-version=${version};\necho "smurg ${says} (fake, protocol v2)"\n`;
}

/** The routes of a published release: latest/VERSION and the version's SHA256SUMS and executable for `target`. */
export function release(version: string, target = HOST_TARGET, executable: string | Buffer = fakeExecutable(version)): Record<string, Route> {
  return {
    'latest/VERSION': `${version}\n`,
    [`v${version}/SHA256SUMS`]: `${sha256('something else')}  smurg-other-arch\n${sha256(executable)}  ${target}\n`,
    [`v${version}/${target}`]: executable,
  };
}
