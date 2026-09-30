# shellcheck shell=sh
# Development environment for the smurg monorepo. SOURCE it (bash or zsh), do not execute it:
#
#   source scripts/env.sh            # silent on success
#   SMURG_ENV_VERBOSE=1 source scripts/env.sh
#
# It puts a supported Node (22 LTS >= 22.18, else 24 LTS) and the repo-local pnpm (.tools) first on PATH, keeps
# tool state inside the repo (ARCHITECTURE §0 rule 4) and returns non-zero, loudly, when no supported Node exists.
# Written for bash 3.2 (macOS /bin/bash) and zsh: no arrays, no globs that may not match, no `local` at top level,
# and everything it defines is prefixed `_smurg_` and unset again.

_smurg_is_sourced=1
if [ -n "${ZSH_VERSION:-}" ]; then
  case "${ZSH_EVAL_CONTEXT:-}" in *:file*) ;; *) _smurg_is_sourced=0 ;; esac
elif [ -n "${BASH_VERSION:-}" ]; then
  # shellcheck disable=SC3028,SC3054
  [ "${BASH_SOURCE[0]:-}" = "${0:-}" ] && _smurg_is_sourced=0
fi
if [ "$_smurg_is_sourced" = 0 ]; then
  echo "scripts/env.sh must be sourced, not executed:  source scripts/env.sh" >&2
  unset _smurg_is_sourced
  exit 1
fi
unset _smurg_is_sourced

# Resolve the repository root from this file's own location, independent of the caller's cwd.
if [ -n "${ZSH_VERSION:-}" ]; then
  eval '_smurg_self="${(%):-%x}"'
elif [ -n "${BASH_VERSION:-}" ]; then
  # shellcheck disable=SC3028,SC3054
  _smurg_self="${BASH_SOURCE[0]}"
else
  echo "scripts/env.sh: unsupported shell (use bash or zsh)" >&2
  return 1
fi
SMURG_ROOT="$(cd "$(dirname "$_smurg_self")/.." && pwd -P)" || {
  echo "scripts/env.sh: cannot resolve the repository root from $_smurg_self" >&2
  unset _smurg_self
  return 1
}
unset _smurg_self
export SMURG_ROOT

# Prints "<score>" for a supported "MAJOR.MINOR.PATCH" and nothing otherwise. 22 >= 22.18.0 (first release that runs
# .ts without flags) is preferred over 24 because .nvmrc says 22; within a major the newest wins.
_smurg_node_score() {
  _smurg_v="${1#v}"
  _smurg_major="${_smurg_v%%.*}"
  _smurg_rest="${_smurg_v#*.}"
  _smurg_minor="${_smurg_rest%%.*}"
  _smurg_patch="${_smurg_rest#*.}"
  case "${_smurg_major}x${_smurg_minor}x${_smurg_patch}" in
    *[!0-9x]* | x* | *xx* | *x) return 0 ;;
  esac
  if [ "$_smurg_major" -eq 22 ] && [ "$_smurg_minor" -ge 18 ]; then
    echo $((2000000000 + _smurg_minor * 100000 + _smurg_patch))
  elif [ "$_smurg_major" -eq 24 ]; then
    echo $((1000000000 + _smurg_minor * 100000 + _smurg_patch))
  fi
}

_smurg_node_bin=""
_smurg_best=0
_smurg_nvm_versions="${NVM_DIR:-$HOME/.nvm}/versions/node"
if [ -d "$_smurg_nvm_versions" ]; then
  # `ls` instead of a glob: zsh aborts the whole command on a glob without matches.
  _smurg_list="$(ls -1 "$_smurg_nvm_versions" 2>/dev/null)"
  while IFS= read -r _smurg_name; do
    [ -n "$_smurg_name" ] || continue
    [ -x "$_smurg_nvm_versions/$_smurg_name/bin/node" ] || continue
    _smurg_score="$(_smurg_node_score "$_smurg_name")"
    if [ -n "$_smurg_score" ] && [ "$_smurg_score" -gt "$_smurg_best" ]; then
      _smurg_best="$_smurg_score"
      _smurg_node_bin="$_smurg_nvm_versions/$_smurg_name/bin"
    fi
  done <<EOF
$_smurg_list
EOF
fi

# Fall back to whatever `node` is already on PATH, but only if it is itself a supported version.
if [ -z "$_smurg_node_bin" ] && command -v node >/dev/null 2>&1; then
  _smurg_current="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if [ -n "$(_smurg_node_score "${_smurg_current:-x}")" ]; then
    _smurg_node_bin="$(dirname "$(command -v node)")"
  fi
fi

_smurg_cleanup() {
  unset _smurg_node_bin _smurg_best _smurg_nvm_versions _smurg_list _smurg_name _smurg_score _smurg_current \
    _smurg_v _smurg_major _smurg_rest _smurg_minor _smurg_patch _smurg_p _smurg_tools_bin
  unset -f _smurg_node_score _smurg_path_remove _smurg_cleanup 2>/dev/null
}

if [ -z "$_smurg_node_bin" ]; then
  {
    echo "scripts/env.sh: ERROR: no supported Node.js found."
    echo "  smurg needs Node 22 LTS (>= 22.18.0) or Node 24 LTS; Node 25 is outside vitest's supported range."
    echo "  Looked in ${NVM_DIR:-$HOME/.nvm}/versions/node and at the current \`node\` ($(node --version 2>/dev/null || echo none))."
    echo "  Install one, e.g.:  nvm install 22"
  } >&2
  _smurg_cleanup
  return 1
fi

# Remove every occurrence of a directory from PATH so that re-sourcing keeps PATH short and ordered.
_smurg_path_remove() {
  _smurg_p=":$PATH:"
  while :; do
    case "$_smurg_p" in
      *":$1:"*) _smurg_p="${_smurg_p%%:"$1":*}:${_smurg_p#*:"$1":}" ;;
      *) break ;;
    esac
  done
  _smurg_p="${_smurg_p#:}"
  PATH="${_smurg_p%:}"
}

_smurg_tools_bin="$SMURG_ROOT/.tools/node_modules/.bin"
_smurg_path_remove "$_smurg_node_bin"
_smurg_path_remove "$_smurg_tools_bin"
PATH="$_smurg_tools_bin:$_smurg_node_bin:$PATH"
export PATH

# Tool state stays in the repo: wrangler writes metrics/logs/caches under $XDG_CONFIG_HOME (relay.md gotcha 16);
# pnpm keeps its store and metadata cache under .tools (pnpm-workspace.yaml).
export XDG_CONFIG_HOME="$SMURG_ROOT/.xdg"
export WRANGLER_SEND_METRICS=false
# A stray `npm` / `npx` (instead of pnpm) keeps its cache and debug logs in the repo too: npm's log rotation would
# otherwise delete the user's own logs in ~/.npm/_logs (build-quality review F4).
export npm_config_cache="$SMURG_ROOT/.tools/npm-cache"
export npm_config_update_notifier=false
# Non-interactive tools: vitest never enters watch mode, wrangler never prompts, pnpm skips its update check.
export CI=true
# `smurg` started from this shell (a test, a review, the dev stack) never opens the developer's own browser for a relay
# login: it prints the URL instead (packages/cli/src/cli/io.ts browserBlock). A developer who wants the browser to
# open for a real login runs that one command with SMURG_NO_BROWSER=0 (CI=true blocks it too: add CI=false).
export SMURG_NO_BROWSER=1

if [ ! -x "$_smurg_tools_bin/pnpm" ] && [ -z "${SMURG_ENV_SKIP_PNPM_CHECK:-}" ]; then
  echo "scripts/env.sh: ERROR: repo-local pnpm missing; run  scripts/bootstrap-tools.sh  (installs it into .tools/)" >&2
  _smurg_cleanup
  return 1
fi

if [ "${SMURG_ENV_VERBOSE:-}" = 1 ]; then
  echo "smurg env: root=$SMURG_ROOT"
  echo "smurg env: node $(node --version) ($_smurg_node_bin/node)"
  if [ -x "$_smurg_tools_bin/pnpm" ]; then echo "smurg env: pnpm $("$_smurg_tools_bin/pnpm" --version) ($_smurg_tools_bin/pnpm)"; fi
  echo "smurg env: XDG_CONFIG_HOME=$XDG_CONFIG_HOME WRANGLER_SEND_METRICS=$WRANGLER_SEND_METRICS CI=$CI npm_config_cache=$npm_config_cache SMURG_NO_BROWSER=$SMURG_NO_BROWSER"
fi

_smurg_cleanup
return 0
