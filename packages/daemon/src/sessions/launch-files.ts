// What the sessions module still writes for an agent session besides the hooks module's launch files (ARCHITECTURE
// §7.6): the guest's pre-seeded `.claude.json`, and the removal of the daemon-owned per-session directories it creates
// itself (a guest terminal's empty settingsDir, the `claude auth` helpers' dirs). The `--settings` / `--mcp-config`
// files are written by ONE writer, HookServer.writeSessionFiles (src/hooks/settings-writer.ts).
import { rm } from 'node:fs/promises';

/**
 * The guest's `$CLAUDE_CONFIG_DIR/.claude.json` with the seed merged in: the session root trusted (without it the trust
 * dialog withholds every hook: claude-hooks.md T3a) and, when the guest supplied an API key, that key approved (2.1.283
 * preselects "No" in its dialog). Everything else the guest's Claude stored stays. Onboarding is left alone.
 */
export function mergeClaudeJson(existing: unknown, seed: { readonly projectPath: string; readonly apiKeySuffix?: string }): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const out: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  const projects = isRecord(out['projects']) ? { ...out['projects'] } : {};
  const project = isRecord(projects[seed.projectPath]) ? { ...(projects[seed.projectPath] as Record<string, unknown>) } : {};
  project['hasTrustDialogAccepted'] = true;
  projects[seed.projectPath] = project;
  out['projects'] = projects;
  if (seed.apiKeySuffix) {
    const responses = isRecord(out['customApiKeyResponses']) ? { ...out['customApiKeyResponses'] } : {};
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    responses['approved'] = [...new Set([...strings(responses['approved']), seed.apiKeySuffix])];
    responses['rejected'] = strings(responses['rejected']).filter((item) => item !== seed.apiKeySuffix);
    out['customApiKeyResponses'] = responses;
  }
  return out;
}

/** The last 20 characters of a key: what Claude Code itself records when a user approves a custom key. */
export function apiKeyApprovalSuffix(apiKey: string): string {
  return apiKey.slice(-20);
}

/** Removes a per-session directory this module created under `<stateDir>/sessions`. */
export async function removeSessionFiles(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
