// TEST ONLY: the daemon test harness (in-memory relay, test identity issuer, temp folders). Feature modules inside
// this package import it relatively (`../testing/index.ts`); other packages (tests/e2e, the CLI's tests) import
// `@smurg/daemon/testing`. Never import it from production code.
export {
  TEST_HOST_NAME,
  TEST_HOST_USER,
  connectTestClient,
  createTestDaemon,
  type ConnectTestClientOptions,
  type TestClient,
  type TestDaemon,
  type TestDaemonOptions,
  type TestDevice,
} from './harness.ts';
export { MEMORY_RELAY_ORIGIN, MemoryClientSocket, MemoryRelay, TestIdentityIssuer, type IssueOptions, type RelayUser, type TappedFrame } from './memory-relay.ts';
export { createTempDir, createTempProject, createTempRunDir, isolatedGitEnv, removeTempDir, removeTempRunDir, type TempProjectOptions } from './temp.ts';
export { registerTestDir, registerTestProcess } from './run-registry.ts';
export { FAKE_CLAUDE_SCRIPT, installFakeClaude, type FakeClaude, type FakeClaudeScenario, type FakeClaudeStep } from './fake-claude.ts';

/** Lets queued microtasks and immediate callbacks run (in-memory relay and channels deliver through them). */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Polls `predicate` until true (real time); throws with `what` on timeout. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, options: { readonly timeoutMs?: number; readonly what?: string } = {}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? 'condition'}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
