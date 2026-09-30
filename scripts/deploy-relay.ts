// Guided production deploy of the relay (Cloudflare Workers, workers.dev, Workers Free plan, Google login). Run it
// through scripts/deploy-relay.sh, which sources scripts/env.sh first (Node 22, the repo's pnpm, and wrangler's login
// kept in <repo>/.xdg). Steps, options and exit codes: apps/relay/scripts/deploy.ts; the owner's guide:
// apps/relay/README.md「部署到 Cloudflare」.
//   scripts/deploy-relay.sh [--url URL] [--google-client-id ID] [--wait S] | --dry-run [...] | --check URL
import { main } from '../apps/relay/scripts/deploy.ts';

process.exitCode = await main(process.argv.slice(2));
