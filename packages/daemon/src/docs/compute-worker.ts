// Worker-thread entry of the document compute pool (compute.ts). Node runs this file directly (type stripping), so it
// uses erasable TypeScript only and imports nothing but the pure diff / merge / Yjs code.
import { parentPort } from 'node:worker_threads';
import { WORKER_BUDGETS, runComputeJob, type ComputeJob } from './compute-job.ts';

interface Request {
  readonly id: number;
  readonly job: ComputeJob;
}

const port = parentPort;
if (port === null) throw new Error('compute-worker.ts must run in a worker thread');

port.on('message', (message: Request) => {
  try {
    const result = runComputeJob(message.job, WORKER_BUDGETS);
    // The update is transferred, not copied.
    port.postMessage({ id: message.id, ok: true, result }, result.update ? [result.update.buffer as ArrayBuffer] : []);
  } catch (err) {
    port.postMessage({ id: message.id, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'compute failed' });
  }
});
