// The sessions module writes no launch file of its own: the `--settings` / `--mcp-config` files of an agent session
// are written by ONE writer, HookServer.writeSessionFiles (src/hooks/settings-writer.ts; ARCHITECTURE §7.6). This is the
// removal of the daemon-owned scratch directories it creates under `<stateDir>/sessions` (the `claude --version`
// probe's).
import { rm } from 'node:fs/promises';

/** Removes a per-session directory this module created under `<stateDir>/sessions`. */
export async function removeSessionFiles(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
