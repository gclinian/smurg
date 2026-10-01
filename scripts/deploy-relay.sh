#!/usr/bin/env bash
# Guided, idempotent production deploy of the relay to your Cloudflare account (Workers Free plan, Google login only),
# on its workers.dev subdomain (the default for a self-hosted relay) or on one Cloudflare Custom Domain (the shared
# relay, https://app.smurg.ai), whichever the top level of apps/relay/wrangler.jsonc says. It never logs in, never sets
# a secret and never reads one: it prints the commands for you.
# Details: apps/relay/scripts/deploy.ts; guide: apps/relay/README.md「部署到 Cloudflare」.
#   scripts/deploy-relay.sh [--url https://<relay host>] [--google-client-id ID] [--take-over-hostname] [--wait S]
#   scripts/deploy-relay.sh --dry-run [--url ...] [--google-client-id ...]     (no deploy, no secrets, no file changes)
#   scripts/deploy-relay.sh --check https://<relay host> [--web-dist DIR]      (e.g. https://app.smurg.ai)
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
. scripts/env.sh || exit 1
exec node scripts/deploy-relay.ts "$@"
