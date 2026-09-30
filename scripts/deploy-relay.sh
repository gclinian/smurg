#!/usr/bin/env bash
# Guided, idempotent production deploy of the relay to your Cloudflare account (workers.dev, Workers Free plan,
# Google login only). It never logs in, never sets a secret and never reads one: it prints the commands for you.
# Details: apps/relay/scripts/deploy.ts; guide: apps/relay/README.md「部署到 Cloudflare」.
#   scripts/deploy-relay.sh [--url https://smurg-relay.<subdomain>.workers.dev] [--google-client-id ID] [--wait S]
#   scripts/deploy-relay.sh --dry-run [--url ...] [--google-client-id ...]     (no deploy, no secrets, no file changes)
#   scripts/deploy-relay.sh --check https://smurg-relay.<subdomain>.workers.dev
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
. scripts/env.sh || exit 1
exec node scripts/deploy-relay.ts "$@"
