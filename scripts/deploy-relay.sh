#!/usr/bin/env bash
# Guided, idempotent production deploy of the relay to your Cloudflare account (Workers Free plan, Google login only),
# on its workers.dev subdomain (the default for a self-hosted relay) or on one Cloudflare Custom Domain (the shared
# relay, https://app.smurg.ai), whichever the top level of apps/relay/wrangler.jsonc says. It never logs in, never sets
# a secret and never reads one: it prints the commands for you.
# Details: apps/relay/scripts/deploy.ts; guide: apps/relay/README.md
# ("Self-hosting on workers.dev", "Self-hosting on your own domain").
#   scripts/deploy-relay.sh [--url https://<relay host>] [--google-client-id ID] [--take-over-hostname] [--wait S]
#   scripts/deploy-relay.sh --dry-run [--url ...] [--google-client-id ...]     (no deploy, no secrets, no file changes)
#   scripts/deploy-relay.sh --check https://<relay host> [--web-dist DIR]      (e.g. https://app.smurg.ai)
#
# --keep-assets DIR (with a deploy or --dry-run; scripts/deploy-relay.ts has the details): the web app files of the
# PREVIOUS published version stay served beside the new ones, so that a tab that was open before the deploy still finds
# the code it loads later (the files are named by their content). DIR is the assets folder of that version's web build,
# made from its tag in a scratch folder, never in this checkout:
#   scratch="$(mktemp -d)" && git archive --prefix=previous/ vX.Y.Z | tar -x -C "$scratch"
#   cd "$scratch/previous" && scripts/bootstrap-tools.sh && source scripts/env.sh
#   pnpm install --frozen-lockfile && pnpm --filter @smurg/web build
#   cd - && scripts/deploy-relay.sh --dry-run --keep-assets "$scratch/previous/apps/web/dist/assets"   # lists them
# Only files named <name>-<hash>.<ext> are taken, only into apps/web/dist/assets; index.html is always the new build's.
# WITHOUT --keep-assets a deploy (and a dry run) says first, before anything is built or uploaded, that the pages open
# when it goes live will not find the code they load later, and names this option; then it goes on.
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
. scripts/env.sh || exit 1
exec node scripts/deploy-relay.ts "$@"
