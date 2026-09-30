// Guard for package scripts that run tools with global side effects (wrangler writes metrics, logs and caches under
// $XDG_CONFIG_HOME, else ~/Library/Preferences/.wrangler). Refuses to continue unless scripts/env.sh was sourced.
// Usage in package.json:  "dev": "node ../../scripts/assert-env.mjs && wrangler dev …"
const problems = [];
if (!process.env.SMURG_ROOT) problems.push('SMURG_ROOT is not set');
if (!process.env.XDG_CONFIG_HOME || !process.env.XDG_CONFIG_HOME.startsWith(process.env.SMURG_ROOT ?? '\0')) {
  problems.push('XDG_CONFIG_HOME does not point into the repository');
}
if (process.env.WRANGLER_SEND_METRICS !== 'false') problems.push('WRANGLER_SEND_METRICS is not "false"');
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 18) || major === 24)) problems.push(`Node ${process.versions.node} is not 22 LTS (>= 22.18) or 24 LTS`);

if (problems.length > 0) {
  console.error(`smurg: ${problems.join('; ')}.\nRun  source scripts/env.sh  from the repository root first.`);
  process.exit(1);
}
