// Router handlers of file.* (interactive channel) and file.upload.* / file.download.* (transfer channel). The router
// has already validated the payload and checked the capability of the caller's CURRENT role (file.read, file.write,
// file.download); everything resource-level (PathGuard, host-only, locks, disk, the transfer connection) happens in the
// services, with the caller's principal. The decoder refuses a type on the wrong socket before it gets here.
import type { DaemonContext } from '../core/context.ts';
import type { Router } from '../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../core/lifecycle.ts';

export function registerFileHandlers(router: Router, ctx: DaemonContext): Disposable {
  const stack = new DisposableStack();
  const { services } = ctx;

  // ---- interactive -------------------------------------------------------------------------------------------------
  stack.add(router.handle('file.tree', (payload, req) => services.files.tree(payload, req.principal)));
  stack.add(router.handle('file.stat', async (payload, req) => ({ entry: await services.files.stat(payload, req.principal) })));
  stack.add(router.handle('file.create', async (payload, req) => ({ entry: await services.files.create(payload, req.principal) })));
  stack.add(router.handle('file.rename', async (payload, req) => ({ entry: await services.files.rename(payload, req.principal) })));
  stack.add(
    router.handle('file.delete', async (payload, req) => {
      await services.files.delete(payload.file, req.principal);
      return {};
    }),
  );
  stack.add(router.handle('file.read', (payload, req) => services.files.read(payload, req.principal)));
  stack.add(router.handle('file.write', (payload, req) => services.files.write(payload, req.principal)));

  // ---- transfer: uploads ---------------------------------------------------------------------------------------------
  stack.add(router.handle('file.upload.plan', (payload, req) => services.uploads.plan(payload, req.conn, req.principal)));
  stack.add(router.handle('file.upload.begin', (payload, req) => services.uploads.begin(payload, req.conn, req.principal)));
  stack.add(router.handle('file.upload.hashes', (payload, req) => services.uploads.hashes(payload, req.conn)));
  stack.add(router.handle('file.upload.chunk', (payload, req) => services.uploads.chunk(payload, req.conn)));
  stack.add(router.handle('file.upload.commit', (payload, req) => services.uploads.commit(payload, req.conn, req.principal)));
  stack.add(
    router.handle('file.upload.abort', async (payload, req) => {
      await services.uploads.abort(payload, req.conn);
      return {};
    }),
  );

  // ---- transfer: downloads -------------------------------------------------------------------------------------------
  stack.add(
    router.handle('file.download.begin', async (payload, req) => {
      const download = await services.downloads.begin(payload, req.conn, req.principal);
      // Chunks only after `.ok`: the client learns the downloadId before the first chunk can arrive.
      req.afterReply(() => download.start());
      return download.result;
    }),
  );
  stack.add(router.on('file.download.ack', (payload, req) => services.downloads.ack(payload, req.conn)));
  stack.add(router.on('file.download.cancel', (payload, req) => services.downloads.cancel(payload, req.conn)));

  return stack;
}
