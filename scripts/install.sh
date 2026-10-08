#!/bin/sh
# smurg installer (SPEC R1: one command installs it; SPEC §6). One line for a host:
#
#   curl -fsSL https://smurg.ai/install.sh | sh
#
# https://smurg.ai/install.sh only redirects (302, apps/site) to https://downloads.smurg.ai/latest/install.sh, the copy
# of this file that belongs to the newest version; every version also keeps its own at
# https://downloads.smurg.ai/v<X.Y.Z>/install.sh (scripts/publish-downloads.sh uploads both; docs/RELEASING.md).
# Or, downloaded first:  sh install.sh [--base-url URL] [--prefix DIR] [--force]
#
#  0. when a smurg is already installed at <prefix>/bin/smurg, asks it whether it is sharing (`smurg status`: exit 0
#     means a workspace is being shared, 5 that a smurg host of another version is; 3 that nothing is) and stops with
#     "stop sharing first" when it is, before anything is downloaded and again right before the executable is
#     replaced: the sessions of a daemon that keeps running would start the NEW `smurg hook` / `smurg mcp` against
#     the OLD daemon (`smurg update` refuses for the same reason). `--force` installs without asking. An installed
#     smurg that cannot say (it does not start: the reason many people run the installer again) does not stop the
#     install; one line says that it could not be asked;
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
# Language: English, or Traditional Chinese (zh-TW) by the rule the smurg command uses (pick_lang below): SMURG_LANG
# (en / zh-TW), else the first non-empty of LC_ALL, LC_MESSAGES, LANG (zh-TW only for a Traditional Chinese locale whose
# codeset is UTF-8 or absent), else, on macOS with none of the three set, the system's preferred languages. Every
# message has both texts side by side: `msg 'English %s' 'zh-TW %s' args...` (printf formats, %s only). The English
# output is ASCII only.
#
# Written for POSIX sh (dash, bash and zsh in sh mode, macOS /bin/sh): no bashisms. Everything runs from `main` on the
# last line, so a download cut short by the network (`curl ... | sh`) runs nothing.
set -eu

SMURG_RELEASE_BASE_URL=''

# The person's locale, saved for pick_lang; then the shell itself runs in the C locale. This must happen BEFORE any
# line with a zh-TW text is read: a shell reads a script piece by piece in the locale in force, and bash under a
# non-UTF-8 multibyte locale (zh_CN.GB2312, ja_JP.eucJP, ko_KR.eucKR, ...) takes the UTF-8 bytes of those texts for
# characters of that encoding and ends in a syntax error. In the C locale every byte is a character of its own.
# Nothing the installer runs needs the person's locale (the downloaded `smurg --version` is the same in every one).
SMURG_USER_LC_ALL="${LC_ALL:-}"
SMURG_USER_LC_MESSAGES="${LC_MESSAGES:-}"
SMURG_USER_LANG="${LANG:-}"
LC_ALL=C
export LC_ALL

# ---- language
lower() { printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_' 'abcdefghijklmnopqrstuvwxyz-'; }

# tag_locale TAG: prints zh-TW or en for a language tag or locale name (zh_TW.UTF-8, zh-Hant-HK, en_GB), nothing for
# any other. Traditional Chinese: the first subtag is zh AND (hant is a subtag, OR hans is not and one of tw/hk/mo is).
tag_locale() {
  tag="$(lower "$1")"
  tag="${tag%%@*}"
  tag="${tag%%.*}"
  case "$tag" in
    en | en-*) printf 'en' ;;
    zh-*)
      case "-$tag-" in
        *-hant-*) printf 'zh-TW' ;;
        *-hans-*) ;;
        *-tw-* | *-hk-* | *-mo-*) printf 'zh-TW' ;;
      esac
      ;;
  esac
}

# Sets $lang (en or zh-TW). The same rule as the smurg command (packages/protocol/src/locale; its test table is run
# against this function too).
pick_lang() {
  lang=en
  case "$(lower "${SMURG_LANG:-}")" in
    en) return 0 ;;
    zh-tw) lang=zh-TW; return 0 ;;
  esac
  # The first NON-EMPTY of the three decides alone (POSIX precedence): LC_ALL=C with LANG=zh_TW.UTF-8 is English.
  locale="${SMURG_USER_LC_ALL:-${SMURG_USER_LC_MESSAGES:-${SMURG_USER_LANG:-}}}"
  if [ -n "$locale" ]; then
    [ "$(tag_locale "$locale")" = zh-TW ] || return 0
    case "$locale" in
      *.*)
        # The zh-TW text is UTF-8: a Big5 terminal would show garbage, so it gets English.
        codeset="${locale#*.}"
        case "$(lower "${codeset%%@*}")" in
          utf-8 | utf8) lang=zh-TW ;;
        esac
        ;;
      *) lang=zh-TW ;;
    esac
    return 0
  fi
  # No locale at all (a macOS terminal started without LANG): the system's preferred languages, the first one that
  # is English or Traditional Chinese. Any failure leaves English.
  [ "$(uname -s 2>/dev/null || true)" = Darwin ] || return 0
  command -v defaults >/dev/null 2>&1 || return 0
  for tag in $(defaults read -g AppleLanguages 2>/dev/null | tr -d '(),"' || true); do
    case "$(tag_locale "$tag")" in
      en) return 0 ;;
      zh-TW) lang=zh-TW; return 0 ;;
    esac
  done
  return 0
}

# msg EN ZH [ARGS...]: one line in the installer's language. Both texts are printf formats (%s only).
msg() {
  if [ "$lang" = zh-TW ]; then fmt="$2"; else fmt="$1"; fi
  shift 2
  # shellcheck disable=SC2059 # the format is one of this script's own texts
  printf "$fmt\n" "$@"
}

# failf EN ZH [ARGS...]: the message on stderr, then exit 1 (or $FAIL_CODE: `FAIL_CODE=2 failf ...` for wrong usage).
failf() {
  if [ "$lang" = zh-TW ]; then fmt="$2"; else fmt="$1"; fi
  shift 2
  # shellcheck disable=SC2059 # the format is one of this script's own texts
  msg 'smurg install: %s' 'smurg 安裝：%s' "$(printf "$fmt" "$@")" >&2
  exit "${FAIL_CODE:-1}"
}

usage() {
  msg 'Usage: sh install.sh [--base-url URL] [--prefix DIR] [--force]' '用法：sh install.sh [--base-url 網址] [--prefix 資料夾] [--force]'
  msg '  --base-url  where the release files are (with SHA256SUMS); or set SMURG_INSTALL_BASE_URL' '  --base-url  發佈檔案所在的網址（含 SHA256SUMS）；也可用環境變數 SMURG_INSTALL_BASE_URL'
  msg '  --prefix    install to <DIR>/bin/smurg (default ~/.local)' '  --prefix    安裝到 <資料夾>/bin/smurg（預設 ~/.local）'
  msg '  --force     install even while the installed smurg is sharing a workspace (without it: stop sharing first)' '  --force     即使已安裝的 smurg 正在分享工作區也照樣安裝（不加的話：請先停止分享）'
  msg '  Language: English or Traditional Chinese, from your locale; SMURG_LANG=en or SMURG_LANG=zh-TW chooses.' '  語言：依照你的系統語言顯示英文或繁體中文；可用 SMURG_LANG=en 或 SMURG_LANG=zh-TW 指定。'
}

parse_args() {
  base_url="${SMURG_INSTALL_BASE_URL:-$SMURG_RELEASE_BASE_URL}"
  prefix="${HOME:-}/.local"
  force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --base-url)
        [ $# -ge 2 ] || FAIL_CODE=2 failf '--base-url needs a URL' '--base-url 需要一個網址'
        base_url="$2"
        shift 2
        ;;
      --base-url=*) base_url="${1#--base-url=}"; shift ;;
      --prefix)
        [ $# -ge 2 ] || FAIL_CODE=2 failf '--prefix needs a folder' '--prefix 需要一個資料夾'
        prefix="$2"
        shift 2
        ;;
      --prefix=*) prefix="${1#--prefix=}"; shift ;;
      --force) force=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) FAIL_CODE=2 failf 'unknown argument %s (--help shows the usage)' '不認得的參數 %s（--help 查看用法）' "$1" ;;
    esac
  done

  if [ -z "$base_url" ]; then
    FAIL_CODE=2 failf 'no download location (this install.sh has no release URL filled in). Use curl -fsSL https://smurg.ai/install.sh | sh, or give the URL of the release files with --base-url <URL> (or SMURG_INSTALL_BASE_URL).' '沒有指定下載位置（這份 install.sh 還沒有填入發佈網址）。請改用 curl -fsSL https://smurg.ai/install.sh | sh，或用 --base-url <網址>（或 SMURG_INSTALL_BASE_URL）指定發佈檔案所在的網址。'
  fi
  base_url="${base_url%/}"
  case "$base_url" in
    https://*) scheme=https ;;
    http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/*) scheme=http ;;
    *) FAIL_CODE=2 failf 'the download location must be an https URL: %s' '下載位置必須是 https 網址：%s' "$base_url" ;;
  esac
  case "$base_url" in
    *[!A-Za-z0-9:/._~%-]*) FAIL_CODE=2 failf 'the download location has characters that are not allowed: %s' '下載位置含有不允許的字元：%s' "$base_url" ;;
  esac
  [ -n "$prefix" ] || FAIL_CODE=2 failf 'the home folder was not found; give the install location with --prefix' '找不到家目錄，請用 --prefix 指定安裝位置'
  bindir="$prefix/bin"
}

# ---- a share that is running
# Asks the smurg that is installed at <prefix>/bin/smurg (the file about to be replaced) whether it is sharing, and
# stops when it is. Its stdin is /dev/null: under `curl ... | sh` the shell's stdin is this script, which the installed
# smurg must not read. Its output is not shown (only the exit code is read), and it contacts nothing.
check_not_sharing() {
  [ "$force" = 0 ] || return 0
  if [ ! -f "$bindir/smurg" ] || [ ! -x "$bindir/smurg" ]; then return 0; fi
  sharing=0
  "$bindir/smurg" status </dev/null >/dev/null 2>&1 || sharing=$?
  case "$sharing" in
    3) return 0 ;;
    0 | 5)
      failf 'smurg is sharing a workspace on this computer; nothing was installed. Stop sharing first (smurg stop, or Ctrl-C in the terminal that runs smurg host), then run the installer again. Replacing smurg while it shares would mix the daemon that is still running with the new smurg commands. (To install all the same, add --force: curl -fsSL https://smurg.ai/install.sh | sh -s -- --force)' 'smurg 正在這台電腦上分享工作區，沒有安裝。請先停止分享（smurg stop，或到執行 smurg host 的終端機按 Ctrl-C），再重新執行安裝程式。分享中換掉 smurg 的話，還在執行的 daemon 會和新版的 smurg 指令混在一起。（仍要安裝請加上 --force：curl -fsSL https://smurg.ai/install.sh | sh -s -- --force）'
      ;;
    *)
      # It could not say (it does not start, or failed): installing again is how that is repaired.
      [ "${sharing_unknown_said:-0}" = 1 ] || msg 'smurg install: the smurg installed at %s could not say whether it is sharing (smurg status ended with %s). If smurg host is running, stop it and start it again after this install.' 'smurg 安裝：安裝在 %s 的 smurg 無法回答是否正在分享（smurg status 的結束代碼是 %s）。如果 smurg host 正在執行，請在安裝完成後停止它，再重新啟動。' "$bindir/smurg" "$sharing"
      sharing_unknown_said=1
      ;;
  esac
}

# ---- which executable
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) failf 'this operating system is not supported: %s (smurg supports macOS and Linux)' '不支援這個作業系統：%s（smurg 支援 macOS 和 Linux）' "$os" ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) failf 'this processor architecture is not supported: %s (smurg has arm64 and x64 builds)' '不支援這個處理器架構：%s（smurg 提供 arm64 與 x64 版本）' "$arch" ;;
  esac
  # An x86_64 shell under Rosetta 2 on Apple silicon: the native build is the right one.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ] && { ldd --version 2>&1 | grep -qi musl; }; then
    failf 'this computer uses musl (Alpine, for example); smurg has only glibc builds for now.' '這台電腦使用 musl（例如 Alpine）；smurg 目前只提供 glibc 版本。'
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
    failf 'curl or wget is needed to download' '需要 curl 或 wget 才能下載'
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    sha_tool=shasum
  else
    failf 'sha256sum or shasum was not found, so the download cannot be verified; nothing was installed' '找不到 sha256sum 或 shasum，無法驗證下載的檔案，因此不安裝'
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
  msg 'smurg install: downloading %s (%s)...' 'smurg 安裝：下載 %s（%s）…' "$name" "$base_url"
  fetch "$base_url/SHA256SUMS" "$tmp/SHA256SUMS" || failf 'cannot download %s/SHA256SUMS (the release URL is wrong, or this version has no SHA256SUMS)' '無法下載 %s/SHA256SUMS（發佈網址不對，或這個版本沒有 SHA256SUMS）' "$base_url"
  expected="$(awk -v n="$name" '($2 == n || $2 == "*" n) && $1 ~ /^[0-9a-f]+$/ && length($1) == 64 { print $1; exit }' "$tmp/SHA256SUMS")"
  [ -n "$expected" ] || failf 'SHA256SUMS does not list %s (this version has no executable for this platform); nothing was installed' 'SHA256SUMS 裡沒有 %s（這個版本沒有提供這個平台的執行檔），不安裝' "$name"
  fetch "$base_url/$name" "$tmp/$name" progress || failf 'cannot download %s/%s (the release has no executable for this platform, or the network dropped); nothing was installed' '無法下載 %s/%s（這個平台的執行檔不在發佈裡，或網路中斷），不安裝' "$base_url" "$name"
  actual="$(sha256_of "$tmp/$name")"
  [ "$actual" = "$expected" ] || failf 'the sha256 of %s does not match (expected %s, got %s): the file may have been tampered with, or the download is incomplete; nothing was installed' '%s 的 sha256 不符（預期 %s，實際 %s）：檔案可能被竄改或下載不完整，不安裝' "$name" "$expected" "$actual"
}

# macOS, after the checksum matched: an ad-hoc signed executable that carries com.apple.quarantine would be stopped by
# Gatekeeper. curl sets no such attribute, so normally there is nothing to remove and nothing is changed.
clear_quarantine() {
  [ "$os" = darwin ] || return 0
  command -v xattr >/dev/null 2>&1 || return 0
  if xattr -p com.apple.quarantine "$1" >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$1" || failf 'cannot remove the com.apple.quarantine attribute of %s; nothing was installed' '無法移除 %s 的 com.apple.quarantine 屬性，不安裝' "$1"
    quarantine_removed=1
  fi
}

install_binary() {
  chmod 755 "$tmp/$name"
  version="$("$tmp/$name" --version 2>"$tmp/version.err")" || {
    sed -n '1,5s/^/  /p' "$tmp/version.err" >&2
    failf 'the downloaded %s does not run on this computer (see the message above); nothing was installed' '下載的 %s 無法在這台電腦上執行（見上面的訊息），不安裝' "$name"
  }
  [ ! -d "$bindir/smurg" ] || failf '%s/smurg is a folder; nothing was installed' '%s/smurg 是一個資料夾，不安裝' "$bindir"
  mkdir -p "$bindir" || failf 'cannot create %s' '無法建立 %s' "$bindir"
  # A share that started while the download ran is not replaced under either.
  check_not_sharing
  cp "$tmp/$name" "$bindir/.smurg.new.$$" || failf 'cannot write to %s' '無法寫入 %s' "$bindir"
  chmod 755 "$bindir/.smurg.new.$$"
  mv -f "$bindir/.smurg.new.$$" "$bindir/smurg" || failf 'cannot write %s/smurg' '無法寫入 %s/smurg' "$bindir"
  msg 'smurg install: installed %s/smurg (%s)' 'smurg 安裝：已安裝 %s/smurg（%s）' "$bindir" "$version"
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
  msg '  %s is not on your PATH. Add this line to %s, then open a new terminal:' '  %s 不在 PATH 裡。請把這一行加到 %s，再重新開啟終端機：' "$bindir" "$profile_file"
  printf '    export PATH="%s:$PATH"\n' "$bindir"
}

summary() {
  printf '\n'
  msg 'smurg is installed:' 'smurg 安裝完成：'
  msg '  Executable: %s/smurg (%s)' '  執行檔：%s/smurg（%s）' "$bindir" "$version"
  [ "$quarantine_removed" = 0 ] || msg '  Removed the com.apple.quarantine attribute of the downloaded file (after its sha256 matched)' '  已移除下載檔案的 com.apple.quarantine 屬性（sha256 驗證相符之後）'
  msg '  License of smurg (MIT, open source): https://smurg.ai/license/' '  smurg 的授權條款（MIT，開放原始碼）：https://smurg.ai/zh-TW/license/'
  msg '  Licenses of the third-party components: %s/THIRD-PARTY-NOTICES.txt' '  第三方元件的授權條款：%s/THIRD-PARTY-NOTICES.txt' "$base_url"
  path_hint
  printf '\n'
  msg 'Next steps:' '下一步：'
  msg '  smurg login                   # log in with your Google account, in a browser, to the built-in public relay (another relay: add --relay <URL>)' '  smurg login                   # 用瀏覽器以 Google 帳號登入 smurg 內建的公用 relay（其他 relay：加上 --relay <網址>）'
  msg '  smurg host <project folder>   # share the folder and print two links: yours, and one for your teammates' '  smurg host <專案資料夾>       # 分享資料夾並印出兩個連結：你自己的、給組員的'
  msg 'To update later: smurg update. To remove it: smurg uninstall. Guide: https://smurg.ai/docs/hosting/' '之後要更新：smurg update；要移除：smurg uninstall。說明：https://smurg.ai/zh-TW/docs/hosting/'
}

main() {
  pick_lang
  parse_args "$@"
  detect_target
  pick_tools
  check_not_sharing
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
