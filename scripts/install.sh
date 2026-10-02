#!/bin/sh
# smurg installer (SPEC R1 「一行指令安裝」, §6 發佈). One line for a host:
#
#   curl -fsSL https://smurg.ai/install.sh | sh
#
# https://smurg.ai/install.sh only redirects (302, apps/site) to https://downloads.smurg.ai/latest/install.sh, the copy
# of this file that belongs to the newest version; every version also keeps its own at
# https://downloads.smurg.ai/v<X.Y.Z>/install.sh (scripts/publish-downloads.sh uploads both; docs/RELEASING.md).
# Or, downloaded first:  sh install.sh [--base-url URL] [--prefix DIR]
#
#  1. picks the single executable for this machine (smurg-darwin-arm64, smurg-darwin-x64, smurg-linux-x64,
#     smurg-linux-arm64; glibc only; an x86_64 shell under Rosetta on Apple silicon gets the arm64 build), downloads it
#     and the release's SHA256SUMS from the release URL, and refuses to install unless the file's sha256 matches (fail
#     closed: no checksum tool, no entry, a mismatch → nothing changes);
#  2. macOS: only after the checksum matched, removes the com.apple.quarantine attribute if the file carries one (the
#     executable is signed ad hoc, not by a Developer ID, so Gatekeeper would stop a quarantined copy); a download by
#     curl normally has none, and then nothing is changed;
#  3. installs it as <prefix>/bin/smurg (0755; default prefix ~/.local) atomically, and says how to put <prefix>/bin on
#     PATH (it never edits a shell profile).
# The same on every platform: no sudo, no system package, nothing outside <prefix>/bin (there is no guest sandbox to
# set up: ARCHITECTURE §11 D-15).
#
# The release URL: --base-url, else $SMURG_INSTALL_BASE_URL, else the one scripts/release-assets.sh wrote below when
# the release was built (https://downloads.smurg.ai/v<X.Y.Z>, the version's own files: so the latest/ copy installs
# exactly its version). https only (http only for 127.0.0.1 / localhost, for tests). Nothing else is contacted, and
# nothing outside <prefix>/bin and a temporary directory is written. The version's THIRD-PARTY-NOTICES.txt (the
# licenses of the third-party software in the executable) stays at the release URL; the summary says where.
#
# Written for POSIX sh (dash, bash and zsh in sh mode, macOS /bin/sh): no bashisms. Everything runs from `main` on the
# last line, so a download cut short by the network (`curl … | sh`) runs nothing.
set -eu

SMURG_RELEASE_BASE_URL=''

say() { printf '%s\n' "$*"; }
fail() {
  printf 'smurg 安裝：%s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  say '用法：sh install.sh [--base-url 網址] [--prefix 資料夾]'
  say '  --base-url  發佈檔案所在的網址（含 SHA256SUMS）；也可用環境變數 SMURG_INSTALL_BASE_URL'
  say '  --prefix    安裝到 <資料夾>/bin/smurg（預設 ~/.local）'
}

parse_args() {
  base_url="${SMURG_INSTALL_BASE_URL:-$SMURG_RELEASE_BASE_URL}"
  prefix="${HOME:-}/.local"
  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url) [ $# -ge 2 ] || fail '--base-url 需要一個網址' 2; base_url="$2"; shift 2 ;;
      --base-url=*) base_url="${1#--base-url=}"; shift ;;
      --prefix) [ $# -ge 2 ] || fail '--prefix 需要一個資料夾' 2; prefix="$2"; shift 2 ;;
      --prefix=*) prefix="${1#--prefix=}"; shift ;;
      -h | --help) usage; exit 0 ;;
      *) fail "不認得的參數 $1（--help 查看用法）" 2 ;;
    esac
  done

  [ -n "$base_url" ] || fail '沒有指定下載位置（這份 install.sh 還沒有填入發佈網址）。請改用 curl -fsSL https://smurg.ai/install.sh | sh，或用 --base-url <網址>（或 SMURG_INSTALL_BASE_URL）指定發佈檔案所在的網址。' 2
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
  say '  smurg 的授權條款：https://smurg.ai/license/'
  say "  第三方元件的授權條款：$base_url/THIRD-PARTY-NOTICES.txt"
  path_hint
  say ''
  say '下一步：'
  say '  smurg login                   # 用瀏覽器以 Google 帳號登入 smurg 內建的公用 relay（維護者提供的其他 relay：加上 --relay <網址>）'
  say '  smurg host <專案資料夾>       # 分享資料夾並印出兩個連結：你自己的、給組員的'
  say '之後要更新：smurg update；要移除：smurg uninstall'
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
  summary
}

main "$@"
