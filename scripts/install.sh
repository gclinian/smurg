#!/bin/sh
# smurg installer (SPEC R1 「一行指令安裝」, §6 發佈; R5: the Linux sandbox dependencies and the Ubuntu 24.04+ AppArmor
# user-namespace restriction). One line for a host:
#
#   curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh
#
# or, downloaded first:  sh install.sh [--base-url URL] [--prefix DIR] [--yes] [--no-deps]
#
#  1. picks the single executable for this machine (smurg-darwin-arm64, smurg-darwin-x64, smurg-linux-x64,
#     smurg-linux-arm64; glibc only; an x86_64 shell under Rosetta on Apple silicon gets the arm64 build), downloads it
#     and the release's SHA256SUMS from the release URL, and refuses to install unless the file's sha256 matches (fail
#     closed: no checksum tool, no entry, a mismatch → nothing changes);
#  2. macOS: only after the checksum matched, removes the com.apple.quarantine attribute if the file carries one (the
#     executable is signed ad hoc, not by a Developer ID, so Gatekeeper would stop a quarantined copy); a download by
#     curl normally has none, and then nothing is changed;
#  3. installs it as <prefix>/bin/smurg (0755; default prefix ~/.local, no sudo) atomically, and says how to put
#     <prefix>/bin on PATH (it never edits a shell profile);
#  4. Linux: checks bubblewrap, socat and ripgrep (the guest sandbox needs them) and, on Ubuntu 24.04+, the AppArmor
#     restriction that stops bubblewrap; ONLY with the person's consent (asked on the terminal, or --yes) it runs
#     `sudo apt-get install …` and installs an AppArmor profile for /usr/bin/bwrap; otherwise it prints the commands.
#
# The release URL: --base-url, else $SMURG_INSTALL_BASE_URL, else the one scripts/release-assets.sh wrote below when
# the release was built (the GitHub release download URL of that tag). https only (http only for 127.0.0.1 /
# localhost, for tests). Nothing else is contacted; nothing outside <prefix>/bin and a temporary directory is written
# except, with consent, the apt packages and /etc/apparmor.d/smurg-bwrap.
#
# Written for POSIX sh (dash, bash and zsh in sh mode, macOS /bin/sh): no bashisms. Everything runs from `main` on the
# last line, so a download cut short by the network (`curl … | sh`) runs nothing.
#
# Tests only (packages/cli/test/install-script.test.ts): SMURG_INSTALL_TEST_SYSROOT=<dir> makes the Linux checks look
# for the system tools, the AppArmor switch and the profile below <dir> instead of /. The commands the script runs are
# still looked up on PATH (the tests put stand-ins there), and nothing is ever written below <dir>.
set -eu

SMURG_RELEASE_BASE_URL=''

say() { printf '%s\n' "$*"; }
fail() {
  printf 'smurg 安裝：%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  say '用法：sh install.sh [--base-url 網址] [--prefix 資料夾] [--yes] [--no-deps]'
  say '  --base-url  發佈檔案所在的網址（含 SHA256SUMS）；也可用環境變數 SMURG_INSTALL_BASE_URL'
  say '  --prefix    安裝到 <資料夾>/bin/smurg（預設 ~/.local）'
  say '  --yes       Linux：不詢問，直接安裝沙盒需要的套件與 AppArmor 設定（需要 sudo）'
  say '  --no-deps   Linux：不檢查、不安裝沙盒需要的套件'
}

parse_args() {
  base_url="${SMURG_INSTALL_BASE_URL:-$SMURG_RELEASE_BASE_URL}"
  prefix="${HOME:-}/.local"
  assume_yes=0
  deps=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url) [ $# -ge 2 ] || fail '--base-url 需要一個網址' 2; base_url="$2"; shift 2 ;;
      --base-url=*) base_url="${1#--base-url=}"; shift ;;
      --prefix) [ $# -ge 2 ] || fail '--prefix 需要一個資料夾' 2; prefix="$2"; shift 2 ;;
      --prefix=*) prefix="${1#--prefix=}"; shift ;;
      --yes | -y) assume_yes=1; shift ;;
      --no-deps) deps=0; shift ;;
      -h | --help) usage; exit 0 ;;
      *) fail "不認得的參數 $1（--help 查看用法）" 2 ;;
    esac
  done

  [ -n "$base_url" ] || fail '沒有指定下載位置。請用 --base-url <網址>（或 SMURG_INSTALL_BASE_URL）指定提供 smurg 的人給你的發佈網址。' 2
  base_url="${base_url%/}"
  case "$base_url" in
    https://*) scheme=https ;;
    http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/*) scheme=http ;;
    *) fail "下載位置必須是 https 網址：$base_url" 2 ;;
  esac
  case "$base_url" in
    *[!A-Za-z0-9:/._~%-]*) fail "下載位置含有不允許的字元：$base_url" 2 ;;
  esac
  [ -n "$prefix" ] || fail '找不到家目錄，請用 --prefix 指定安裝位置' 2
}

# ---- which executable
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "不支援這個作業系統：$os（smurg 支援 macOS 和 Linux）" ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "不支援這個處理器架構：$arch（smurg 提供 arm64 與 x64 版本）" ;;
  esac
  # An x86_64 shell under Rosetta 2 on Apple silicon: the native build is the right one.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ] && { ldd --version 2>&1 | grep -qi musl; }; then
    fail '這台電腦使用 musl（例如 Alpine）；smurg 目前只提供 glibc 版本。'
  fi
  name="smurg-$os-$arch"
}

# ---- download and verify
pick_tools() {
  if command -v curl >/dev/null 2>&1; then
    downloader=curl
  elif command -v wget >/dev/null 2>&1; then
    downloader=wget
  else
    fail '需要 curl 或 wget 才能下載'
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    sha_tool=shasum
  else
    fail '找不到 sha256sum 或 shasum，無法驗證下載的檔案，因此不安裝'
  fi
}

# fetch URL FILE [progress]: redirects are followed, but never away from the scheme of the release URL.
fetch() {
  if [ "$downloader" = curl ]; then
    if [ "${3:-}" = progress ] && [ -t 2 ]; then
      curl -fL -# --proto "=$scheme" --proto-redir "=$scheme" --retry 2 -o "$2" "$1"
    else
      curl -fsSL --proto "=$scheme" --proto-redir "=$scheme" --retry 2 -o "$2" "$1"
    fi
  else
    wget -q -O "$2" "$1"
  fi
}

sha256_of() {
  if [ "$sha_tool" = sha256sum ]; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

download_and_verify() {
  say "smurg 安裝：下載 $name（$base_url）…"
  fetch "$base_url/SHA256SUMS" "$tmp/SHA256SUMS" || fail "無法下載 $base_url/SHA256SUMS（發佈網址不對，或這個版本沒有 SHA256SUMS）"
  expected="$(awk -v n="$name" '($2 == n || $2 == "*" n) && $1 ~ /^[0-9a-f]+$/ && length($1) == 64 { print $1; exit }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS 裡沒有 $name（這個版本沒有提供這個平台的執行檔），不安裝"
  fetch "$base_url/$name" "$tmp/$name" progress || fail "無法下載 $base_url/$name（這個平台的執行檔不在發佈裡，或網路中斷），不安裝"
  actual="$(sha256_of "$tmp/$name")"
  [ "$actual" = "$expected" ] || fail "$name 的 sha256 不符（預期 $expected，實際 $actual）：檔案可能被竄改或下載不完整，不安裝"
}

# macOS, after the checksum matched: an ad-hoc signed executable that carries com.apple.quarantine would be stopped by
# Gatekeeper. curl sets no such attribute, so normally there is nothing to remove and nothing is changed.
clear_quarantine() {
  [ "$os" = darwin ] || return 0
  command -v xattr >/dev/null 2>&1 || return 0
  if xattr -p com.apple.quarantine "$1" >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$1" || fail "無法移除 $1 的 com.apple.quarantine 屬性，不安裝"
    quarantine_removed=1
  fi
}

install_binary() {
  chmod 755 "$tmp/$name"
  version="$("$tmp/$name" --version 2>"$tmp/version.err")" || {
    sed -n '1,5s/^/  /p' "$tmp/version.err" >&2
    fail "下載的 $name 無法在這台電腦上執行（見上面的訊息），不安裝"
  }
  bindir="$prefix/bin"
  [ ! -d "$bindir/smurg" ] || fail "$bindir/smurg 是一個資料夾，不安裝"
  mkdir -p "$bindir" || fail "無法建立 $bindir"
  cp "$tmp/$name" "$bindir/.smurg.new.$$" || fail "無法寫入 $bindir"
  chmod 755 "$bindir/.smurg.new.$$"
  mv -f "$bindir/.smurg.new.$$" "$bindir/smurg" || fail "無法寫入 $bindir/smurg"
  say "smurg 安裝：已安裝 $bindir/smurg（$version）"
}

# ---- Linux: what the guest sandbox needs (R5)
ask() {
  [ "$assume_yes" = 1 ] && return 0
  # Only a person at a terminal can consent (curl | sh: stdin is the script, so ask on /dev/tty).
  [ -t 1 ] || return 1
  (exec </dev/tty) 2>/dev/null || return 1
  printf '%s [y/N] ' "$1" >/dev/tty || return 1
  read -r answer </dev/tty || return 1
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

have_tool() {
  for dir in /usr/bin /bin /usr/local/bin /usr/sbin /sbin; do
    [ -x "$sysroot$dir/$1" ] && return 0
  done
  return 1
}

# Runs a command as root: directly when we are root, through sudo otherwise (sudo asks for the password on the terminal).
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

can_be_root() {
  [ "$(id -u)" = 0 ] || command -v sudo >/dev/null 2>&1
}

linux_sandbox_setup() {
  sysroot="${SMURG_INSTALL_TEST_SYSROOT:-}"
  missing=''
  have_tool bwrap || missing="$missing bubblewrap"
  have_tool socat || missing="$missing socat"
  have_tool rg || missing="$missing ripgrep"
  if [ -z "$missing" ]; then
    deps_state='已經有 bubblewrap、socat、ripgrep'
  else
    deps_state="還沒安裝：${missing# }（見上方的指令）"
    say "smurg 安裝：客人沙盒需要的套件還沒安裝：${missing# }"
    if have_tool apt-get && can_be_root && ask "要現在執行 sudo apt-get update 與 sudo apt-get install -y$missing 嗎？"; then
      as_root apt-get update -qq </dev/null || say 'smurg 安裝：apt-get update 失敗，仍然嘗試安裝。'
      # shellcheck disable=SC2086 # $missing is a list of package names
      if as_root apt-get install -y $missing </dev/null; then
        deps_state="已安裝：${missing# }"
      else
        say "smurg 安裝：套件安裝失敗，請自行安裝：sudo apt-get install$missing"
      fi
    elif have_tool apt-get; then
      say "  請自行安裝（Ubuntu / Debian）：sudo apt-get install$missing"
      say '  在那之前，runner 角色的組員無法在這台電腦上開 session。'
    else
      say "  請用這台電腦的套件管理程式安裝：$missing"
      say '  在那之前，runner 角色的組員無法在這台電腦上開 session。'
    fi
  fi

  apparmor_state='不需要（這台電腦沒有限制 user namespace）'
  restricted="$(cat "$sysroot/proc/sys/kernel/apparmor_restrict_unprivileged_userns" 2>/dev/null || echo 0)"
  [ "$restricted" = 1 ] || return 0
  # Decided by what bubblewrap can do, not by whether the profile FILE exists: a file that is there but not loaded
  # (apparmor_parser failed, the profile was removed with -R, the file was edited) left bubblewrap blocked while this
  # said 「已經有」 (review linux-binary F4). The probe is the daemon's own (sandbox/checks.ts bwrapUsernsBlocked).
  userns=unknown
  if bwrap_userns_probe; then
    userns=works
  elif [ -x "$sysroot/usr/bin/bwrap" ]; then
    case "$probe_err" in
      *'Permission denied'* | *'Operation not permitted'*) userns=blocked ;;
      *) userns=other ;;
    esac
  fi
  if [ "$userns" = works ]; then
    apparmor_state='已生效（bubblewrap 可以建立客人沙盒）'
    return 0
  fi
  if [ "$userns" = other ]; then
    # Not the restriction's way of failing: nothing to fix here; smurg host checks the whole sandbox.
    apparmor_state="無法確認（bubblewrap：$(printf '%s\n' "$probe_err" | sed -n '1p' | cut -c1-160)；smurg host 會再檢查）"
    return 0
  fi
  if [ "$userns" = unknown ] && [ -e "$sysroot/etc/apparmor.d/smurg-bwrap" ]; then
    apparmor_state='已經有 /etc/apparmor.d/smurg-bwrap（還沒有 bubblewrap 可以確認是否生效；smurg host 會檢查）'
    return 0
  fi
  apparmor_state='還沒處理（見上方的指令）'
  profile='abi <abi/4.0>,
include <tunables/global>
profile smurg-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}'
  say 'smurg 安裝：這台電腦的 AppArmor 限制了 user namespace（Ubuntu 24.04 以上的預設），客人沙盒（bubblewrap）會無法啟動。'
  if [ -e "$sysroot/etc/apparmor.d/smurg-bwrap" ]; then
    say '  /etc/apparmor.d/smurg-bwrap 已經存在，但沒有生效（沒有載入，或內容不對）：會重新寫入並載入。'
  fi
  if have_tool apparmor_parser && can_be_root && ask '要安裝只放寬 /usr/bin/bwrap 的 AppArmor 設定檔（/etc/apparmor.d/smurg-bwrap）嗎？'; then
    if printf '%s\n' "$profile" | as_root tee /etc/apparmor.d/smurg-bwrap >/dev/null && as_root apparmor_parser -r /etc/apparmor.d/smurg-bwrap </dev/null; then
      if [ "$userns" = blocked ] && ! bwrap_userns_probe; then
        apparmor_state='已安裝 /etc/apparmor.d/smurg-bwrap，但 bubblewrap 仍然無法建立 user namespace（smurg host 會再檢查）'
        say 'smurg 安裝：AppArmor 設定檔已安裝，但 bubblewrap 仍然無法啟動。'
      else
        apparmor_state='已安裝 /etc/apparmor.d/smurg-bwrap（只放寬 /usr/bin/bwrap）'
        say 'smurg 安裝：AppArmor 設定檔已安裝。'
      fi
    else
      say 'smurg 安裝：AppArmor 設定檔安裝失敗，請參考下面的指令自行處理。'
    fi
  fi
  case "$apparmor_state" in
    已安裝*) ;;
    *)
      say '  請自行建立 /etc/apparmor.d/smurg-bwrap，內容如下，再執行 sudo apparmor_parser -r /etc/apparmor.d/smurg-bwrap：'
      printf '%s\n' "$profile" | sed 's/^/    /'
      say '  或（放寬整台電腦的限制，不建議）：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'
      ;;
  esac
}

# Can /usr/bin/bwrap create the user and network namespaces a guest sandbox needs? Its error text is left in
# $probe_err. False (with an empty $probe_err) when there is no /usr/bin/bwrap: the AppArmor profile names that path.
# The restriction applies to unprivileged users only: run as root (`sudo sh install.sh`, a root login) bubblewrap
# passes whether or not the profile is loaded, while `smurg host` runs as the user and stays blocked (review RV-5).
# So as root the probe runs as the user sudo came from (else nobody), through runuser; without runuser it cannot be
# decided here (the daemon checks again).
bwrap_userns_probe() {
  probe_err=''
  [ -x "$sysroot/usr/bin/bwrap" ] || return 1
  if [ "$(id -u)" != 0 ]; then
    probe_err="$("$sysroot/usr/bin/bwrap" --unshare-user --unshare-net --ro-bind / / -- /bin/true 2>&1 >/dev/null </dev/null)"
    return
  fi
  probe_user="${SUDO_USER:-nobody}"
  [ -n "$probe_user" ] && [ "$probe_user" != root ] || probe_user=nobody
  if ! command -v runuser >/dev/null 2>&1; then
    probe_err="cannot run the check as $probe_user (no runuser)"
    return 1
  fi
  probe_err="$(cd / && runuser -u "$probe_user" -- "$sysroot/usr/bin/bwrap" --unshare-user --unshare-net --ro-bind / / -- /bin/true 2>&1 >/dev/null </dev/null)"
}

# ---- what happened, and how to run it
path_hint() {
  case ":${PATH:-}:" in
    *":$bindir:"*) return 0 ;;
  esac
  # shellcheck disable=SC2088 # the file name is printed for the person, never expanded or written
  case "${SHELL:-}" in
    */zsh) profile_file='~/.zshrc' ;;
    */bash) if [ "$os" = darwin ]; then profile_file='~/.bash_profile'; else profile_file='~/.bashrc'; fi ;;
    *) profile_file='~/.profile' ;;
  esac
  say "  $bindir 不在 PATH 裡。請把這一行加到 $profile_file，再重新開啟終端機："
  say "    export PATH=\"$bindir:\$PATH\""
}

summary() {
  say ''
  say 'smurg 安裝完成：'
  say "  執行檔：$bindir/smurg（$version）"
  [ "$quarantine_removed" = 0 ] || say '  已移除下載檔案的 com.apple.quarantine 屬性（sha256 驗證相符之後）'
  if [ "$os" = linux ]; then
    if [ "$deps" = 1 ]; then
      say "  客人沙盒需要的套件：$deps_state"
      say "  AppArmor：$apparmor_state"
    else
      say '  客人沙盒需要的套件與 AppArmor：沒有檢查（--no-deps）'
    fi
  fi
  path_hint
  say ''
  say '下一步：'
  say '  smurg login                   # 用瀏覽器以 Google 帳號登入 smurg 內建的公用 relay（自己架設的 relay：加上 --relay <網址>）'
  say '  smurg host <專案資料夾>       # 分享資料夾並印出邀請連結；smurg host 會檢查客人沙盒是否可用'
}

main() {
  parse_args "$@"
  detect_target
  pick_tools
  quarantine_removed=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/smurg-install.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  trap 'rm -rf "$tmp"; exit 130' INT TERM
  download_and_verify
  clear_quarantine "$tmp/$name"
  install_binary
  if [ "$os" = linux ] && [ "$deps" = 1 ]; then
    linux_sandbox_setup
  fi
  summary
}

main "$@"
