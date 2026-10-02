#!/usr/bin/env bash
# Publishes a smurg release on https://downloads.smurg.ai (Cloudflare R2 bucket smurg-downloads), then switches
# latest/. Run by a person (a maintainer), never by CI. Details, options and exit codes:
# scripts/publish-downloads.ts; runbook: docs/RELEASING.md §4 (publish) and §7 (roll back).
#   scripts/publish-downloads.sh --version X.Y.Z (--from-release | --dist DIR) [--dry-run] [--resume] [--no-latest] [--wait S]
#   scripts/publish-downloads.sh --check [--version X.Y.Z]
#   scripts/publish-downloads.sh --set-latest X.Y.Z [--dry-run] [--wait S]
cd "$(dirname "$0")/.." || exit 1
# gh keeps its login in $GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else ~/.config/gh. scripts/env.sh points
# XDG_CONFIG_HOME at the repository's .xdg/ (wrangler's login), where gh finds no login: remember the person's own gh
# config first (unless this shell already sourced env.sh, whose XDG_CONFIG_HOME is not the person's).
root="$(pwd -P)"
# Where XDG_CONFIG_HOME really is, also when the directory does not exist yet (a fresh checkout has no .xdg/): the
# directory itself when it exists, else its parent resolved plus its own name.
xdg_real=""
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  xdg_real="$(cd "$XDG_CONFIG_HOME" 2>/dev/null && pwd -P)" || xdg_real=""
  if [ -z "$xdg_real" ]; then
    xdg_parent="$(cd "$(dirname "$XDG_CONFIG_HOME")" 2>/dev/null && pwd -P)" || xdg_parent="$(dirname "$XDG_CONFIG_HOME")"
    xdg_real="${xdg_parent%/}/$(basename "$XDG_CONFIG_HOME")"
  fi
fi
if [ -n "${GH_CONFIG_DIR:-}" ]; then
  SMURG_GH_CONFIG_DIR="$GH_CONFIG_DIR"
elif [ -n "${XDG_CONFIG_HOME:-}" ] && [ "$xdg_real" != "$root/.xdg" ]; then
  SMURG_GH_CONFIG_DIR="$XDG_CONFIG_HOME/gh"
else
  SMURG_GH_CONFIG_DIR="${HOME:-}/.config/gh"
fi
export SMURG_GH_CONFIG_DIR
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
. scripts/env.sh || exit 1
exec node scripts/publish-downloads.ts "$@"
