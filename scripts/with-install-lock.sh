#!/usr/bin/env bash
# Runs a command while holding the repository's install lock, so that engineers working in parallel never run two
# `pnpm install`s against the same node_modules at once:
#
#   scripts/with-install-lock.sh pnpm install
#   scripts/with-install-lock.sh pnpm --filter @smurg/daemon add some-pkg@1.2.3
#
# The lock is a directory (mkdir is atomic). It is released on exit, including Ctrl-C. A lock whose owner process is
# gone, or that is older than SMURG_INSTALL_LOCK_STALE_SECS (default 900), is treated as stale and broken.
# Liveness is checked with `ps -p` (read-only): this script never signals a process it did not start (§0 rule 1).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The command runs with the same Node, pnpm and store as everyone else.
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
source "$ROOT/scripts/env.sh" || exit 1
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/with-install-lock.sh <command> [args...]" >&2
  exit 2
fi

LOCK_DIR="$ROOT/.tools/install.lock"
STALE_SECS="${SMURG_INSTALL_LOCK_STALE_SECS:-900}"
WAIT_SECS="${SMURG_INSTALL_LOCK_WAIT_SECS:-1800}"
HOST="$(hostname 2>/dev/null || echo unknown)"
mkdir -p "$ROOT/.tools"

owned=0
release() {
  if [ "$owned" = 1 ]; then
    rm -rf "$LOCK_DIR"
    owned=0
  fi
}
trap release EXIT
trap 'release; exit 130' INT
trap 'release; exit 143' TERM

lock_is_stale() {
  local owner pid started host now
  owner="$(cat "$LOCK_DIR/owner" 2>/dev/null || true)"
  now="$(date +%s)"
  if [ -z "$owner" ]; then
    # Owner file not written yet (the holder is between mkdir and echo) or the holder died right there:
    # only an old, empty lock directory counts as stale.
    [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +1 2>/dev/null)" ]
    return
  fi
  read -r pid started host <<<"$owner"
  if [ -n "${started:-}" ] && [ $((now - started)) -gt "$STALE_SECS" ]; then
    return 0
  fi
  if [ "${host:-}" = "$HOST" ] && [ -n "${pid:-}" ] && ! ps -p "$pid" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

deadline=$(($(date +%s) + WAIT_SECS))
last_notice=0
while :; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    owned=1
    echo "$$ $(date +%s) $HOST" >"$LOCK_DIR/owner"
    break
  fi
  if lock_is_stale; then
    echo "with-install-lock: breaking stale lock ($(cat "$LOCK_DIR/owner" 2>/dev/null || echo 'no owner'))" >&2
    # Rename first so that two waiters cannot both delete a lock that a third one has just re-created.
    if mv "$LOCK_DIR" "$LOCK_DIR.stale.$$" 2>/dev/null; then
      rm -rf "$LOCK_DIR.stale.$$"
    fi
    continue
  fi
  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    echo "with-install-lock: gave up after ${WAIT_SECS}s; lock held by: $(cat "$LOCK_DIR/owner" 2>/dev/null || echo unknown)" >&2
    exit 75
  fi
  if [ $((now - last_notice)) -ge 30 ]; then
    echo "with-install-lock: waiting for install lock held by: $(cat "$LOCK_DIR/owner" 2>/dev/null || echo unknown)" >&2
    last_notice="$now"
  fi
  sleep 1
done

"$@"
status=$?
release
exit "$status"
