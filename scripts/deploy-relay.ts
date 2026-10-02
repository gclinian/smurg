// Guided production deploy of the relay (Cloudflare Workers Free plan, Google login; on workers.dev or one custom
// domain). Run it through scripts/deploy-relay.sh, which sources scripts/env.sh first (Node 22, the repo's pnpm, and
// wrangler's login kept in <repo>/.xdg). Steps, options and exit codes: apps/relay/scripts/deploy.ts; the guide:
// apps/relay/README.md ("Self-hosting on workers.dev", "Self-hosting on your own domain").
//   scripts/deploy-relay.sh [--url URL] [--google-client-id ID] [--take-over-hostname] [--wait S] | --dry-run [...]
//                           | --check URL [--web-dist DIR]
import { main } from '../apps/relay/scripts/deploy.ts';

process.exitCode = await main(process.argv.slice(2));
