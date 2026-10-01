#!/usr/bin/env bash
# The files of one smurg release, ready to upload (docs/RELEASING.md; .github/workflows/release.yml runs it):
#
#   scripts/release-assets.sh --version X.Y.Z --base-url https://<where the files will be served>
#                             [--dist DIR] [--out DIR] [--require-all] [--check-arch] [--notes FILE] [--changelog FILE]
#   scripts/release-assets.sh --version X.Y.Z --base-url https://… --check-changelog [--changelog FILE]
#   scripts/release-assets.sh --version X.Y.Z --base-url https://… --publish-checks [--changelog FILE]
#
# Takes every <dist>/smurg-<platform>-<arch> (default dist: packages/cli/dist) that scripts/build-sea.sh --version X.Y.Z
# built, each on its own platform, and writes into <out> (default packages/cli/dist/release/X.Y.Z):
#   smurg-<platform>-<arch>   the executables (0755)
#   SHA256SUMS               their sha256 (what scripts/install.sh verifies before installing)
#   install.sh               scripts/install.sh with the release URL filled in (`curl -fsSL <url>/install.sh | sh`)
# The asset names are exactly the ones scripts/install.sh downloads: smurg-darwin-arm64, smurg-darwin-x64,
# smurg-linux-x64, smurg-linux-arm64. For a GitHub release the base URL is the download URL of the tag,
# https://github.com/<owner>/<repo>/releases/download/vX.Y.Z, so the install.sh behind
# https://github.com/<owner>/<repo>/releases/latest/download/install.sh always installs the executables of its own
# release. For the official repository (github.com/gclinian/smurg) the install line people are given is
# `curl -fsSL https://smurg.ai/install.sh | sh`: smurg.ai (apps/site) only answers that path with a 302 to the
# GitHub URL above, so it is the same file; the GitHub URL stays the fallback when smurg.ai is unreachable.
#
#   --require-all  refuse unless all four executables are there (a release; without it any subset is taken)
#   --check-arch   check with `file` that each executable is the Mach-O / ELF of its name's architecture
#   --notes FILE   write the release notes: the CHANGELOG section of this version (refused when there is none), the
#                  install commands (official repository: smurg.ai first, then the GitHub URLs) and the checksums
#   --changelog F  the changelog to read (default CHANGELOG.md)
#   --check-changelog  only check that the changelog has a section for X.Y.Z (and that the version and URL are
#                  valid), print it and stop: the release workflow runs this before building anything
#   --publish-checks  only check what a PUBLISHED release needs filled in (docs/RELEASING.md §3, §4), print every
#                  problem and stop (exit 1 on any): the section's heading has a date (`## [X.Y.Z] - YYYY-MM-DD`,
#                  not `Unreleased`); no placeholder (<RELAY_URL>, <account-subdomain>) is left in the section or in
#                  the user docs; DEFAULT_RELAY_URL (packages/cli/src/relay/default-relay.ts) is an https origin, since
#                  every binary keeps its built-in relay forever, and the user docs (README.md, docs/HOSTING.md,
#                  docs/JOINING.md) name that same relay; for the official repository, those three docs show the
#                  install line `curl -fsSL https://smurg.ai/install.sh | sh`, and neither they nor the section name a
#                  concrete *.workers.dev address other than the built-in relay (a stale address of the shared relay;
#                  a self-hosted one is written with a <placeholder>); every package.json says version X.Y.Z (without a
#                  pre-release part). The release workflow runs it before building: it fails a tag, and only warns in a
#                  dry run.
# The executable for this machine, if present, is run once: it must report exactly `smurg X.Y.Z (…`.
# Nothing is uploaded or signed here.
set -euo pipefail
cd "$(dirname "$0")/.."

version=''
base_url=''
dist='packages/cli/dist'
out=''
require_all=0
check_arch=0
check_changelog=0
publish_checks=0
notes=''
changelog='CHANGELOG.md'
need() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "release-assets: $1 needs a value" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --version) need "$@"; version="$2"; shift 2 ;;
    --base-url) need "$@"; base_url="$2"; shift 2 ;;
    --dist) need "$@"; dist="$2"; shift 2 ;;
    --out) need "$@"; out="$2"; shift 2 ;;
    --notes) need "$@"; notes="$2"; shift 2 ;;
    --changelog) need "$@"; changelog="$2"; shift 2 ;;
    --require-all) require_all=1; shift ;;
    --check-arch) check_arch=1; shift ;;
    --check-changelog) check_changelog=1; shift ;;
    --publish-checks) publish_checks=1; shift ;;
    -h | --help) sed -n '2,41p' "$0"; exit 0 ;;
    *) echo "release-assets: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ "$version" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$ ]] || { echo 'release-assets: --version X.Y.Z is required (no leading v)' >&2; exit 2; }
[[ "$base_url" =~ ^https://[A-Za-z0-9._~%/:-]+$ ]] || { echo 'release-assets: --base-url must be an https URL' >&2; exit 2; }
base_url="${base_url%/}"
out="${out:-packages/cli/dist/release/$version}"

# The release notes need this version's CHANGELOG section: refuse before anything is written.
# The section whose heading is `## [X.Y.Z]`, `## X.Y.Z` or `## vX.Y.Z` (anything may follow, e.g. a date), up to the
# next `## ` heading, without leading and trailing blank lines. `changelog_part heading` prints that heading instead.
changelog_part() {
  awk -v v="$version" -v want="$1" '
    function heading(line) { return line ~ /^## / }
    function ours(line,   rest, next_char) {
      rest = substr(line, 4); sub(/^\[/, "", rest); sub(/^v/, "", rest)
      next_char = substr(rest, length(v) + 1, 1)
      return substr(rest, 1, length(v)) == v && (next_char == "]" || next_char == " " || next_char == "")
    }
    heading($0) { if (inside) exit; if (ours($0)) { if (want == "heading") { print; exit } inside = 1; next } }
    inside { print }
  ' "$changelog"
}
# A GitHub release: its repository, its tag, and the URL that always serves the latest release's install.sh. The
# official repository's latest release is also installed through https://smurg.ai/install.sh (a 302 to that URL); a
# fork's is not (smurg.ai installs the official release), so it gets the GitHub URL only.
official_repo='https://github.com/gclinian/smurg'
official_install='https://smurg.ai/install.sh'
repo_url=''
tag=''
latest=''
short_latest=''
if [[ "$base_url" =~ ^(https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/releases/download/([^/]+)$ ]]; then
  repo_url="${BASH_REMATCH[1]}"
  tag="${BASH_REMATCH[2]}"
  latest="$repo_url/releases/latest/download/install.sh"
  [ "$repo_url" != "$official_repo" ] || short_latest="$official_install"
fi

section=''
if [ -n "$notes" ] || [ "$check_changelog" = 1 ] || [ "$publish_checks" = 1 ]; then
  [ -f "$changelog" ] || { echo "release-assets: $changelog not found" >&2; exit 1; }
  section="$(changelog_part section | sed -e '/./,$!d' | awk '{ lines[NR] = $0 } END { n = NR; while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }')"
  [ -n "$section" ] || { echo "release-assets: $changelog has no section for $version (a heading like '## [$version]')" >&2; exit 1; }
fi
if [ "$publish_checks" = 1 ]; then
  problems=()
  heading="$(changelog_part heading)"
  [[ "$heading" =~ \ -\ [0-9]{4}-[0-9]{2}-[0-9]{2}([[:space:]]|$) ]] || problems+=("$changelog: the heading '$heading' has no release date (## [$version] - YYYY-MM-DD)")
  placeholders='<RELAY_URL>|<account-subdomain>|<這個網址>'
  if printf '%s\n' "$section" | grep -Eq "$placeholders"; then problems+=("$changelog: the $version section still has a placeholder ($placeholders)"); fi
  for doc in README.md docs/HOSTING.md docs/JOINING.md; do
    if [ -f "$doc" ] && grep -Eq "$placeholders" "$doc"; then problems+=("$doc still has a placeholder ($placeholders): docs/RELEASING.md §3"); fi
  done
  default_relay=packages/cli/src/relay/default-relay.ts
  grep -Eq "^export const DEFAULT_RELAY_URL: string \| null = 'https://[a-z0-9.-]+';" "$default_relay" ||
    problems+=("$default_relay: DEFAULT_RELAY_URL is not the deployed relay's https origin (docs/RELEASING.md §3): a binary keeps its built-in relay forever")
  relay_url="$(sed -n "s#^export const DEFAULT_RELAY_URL: string | null = '\(https://[a-z0-9.-]*\)';\$#\1#p" "$default_relay")"
  if [ -n "$relay_url" ]; then
    for doc in README.md docs/HOSTING.md docs/JOINING.md; do
      [ -f "$doc" ] && grep -qF "$relay_url" "$doc" ||
        problems+=("$doc does not name the built-in relay $relay_url (DEFAULT_RELAY_URL): the docs must say what the binary uses")
    done
  fi
  if [ -n "$short_latest" ]; then
    for doc in README.md docs/HOSTING.md docs/JOINING.md; do
      [ -f "$doc" ] && grep -qF "curl -fsSL $short_latest | sh" "$doc" ||
        problems+=("$doc does not show the official install line  curl -fsSL $short_latest | sh")
    done
    # The official relay is DEFAULT_RELAY_URL; any other concrete workers.dev address in what users read is a stale
    # one (the shared relay left workers.dev on 2026-10-01). A self-hosted relay's address is written with a
    # placeholder (https://smurg-relay.<你的子網域>.workers.dev), which this does not match.
    stale_workers_dev() { { grep -Eo 'https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.workers\.dev' | sort -u | grep -vxF "${relay_url:-none}" | tr '\n' ' '; } || true; }
    for doc in README.md docs/HOSTING.md docs/JOINING.md; do
      [ -f "$doc" ] || continue
      stale="$(stale_workers_dev < "$doc")"
      [ -z "$stale" ] || problems+=("$doc names a workers.dev address that is not the built-in relay: ${stale% } (docs/RELEASING.md §3)")
    done
    stale="$(printf '%s\n' "$section" | stale_workers_dev)"
    [ -z "$stale" ] || problems+=("$changelog: the $version section names a workers.dev address that is not the built-in relay: ${stale% }")
  fi
  for pkg in package.json apps/*/package.json packages/*/package.json tests/*/package.json; do
    [ -f "$pkg" ] || continue
    pkg_version="$(sed -n 's/^  "version": "\([^"]*\)",\{0,1\}$/\1/p' "$pkg" | head -1)"
    [ "$pkg_version" = "${version%%-*}" ] || problems+=("$pkg: version '$pkg_version', not ${version%%-*} (smurg --version prints the daemon's)")
  done
  if [ "${#problems[@]}" -gt 0 ]; then
    echo "release-assets: $version is not ready to publish:" >&2
    printf '  - %s\n' "${problems[@]}" >&2
    exit 1
  fi
  echo "release-assets: $version is ready to publish (dated changelog section, no placeholders, built-in relay set and named in the docs, install line, no stale workers.dev address, package versions)"
  exit 0
fi
if [ "$check_changelog" = 1 ]; then
  echo "release-assets: $changelog has a section for $version:"
  printf '%s\n' "$section"
  exit 0
fi

names=(smurg-darwin-arm64 smurg-darwin-x64 smurg-linux-x64 smurg-linux-arm64)
found=()
missing=()
for name in "${names[@]}"; do
  if [ -f "$dist/$name" ]; then found+=("$name"); else missing+=("$name"); fi
done
[ "${#found[@]}" -gt 0 ] || { echo "release-assets: no $dist/smurg-* executables (run scripts/build-sea.sh --version first)" >&2; exit 1; }
if [ "$require_all" = 1 ] && [ "${#missing[@]}" -gt 0 ]; then
  echo "release-assets: missing in $dist: ${missing[*]} (--require-all)" >&2
  exit 1
fi

# The Mach-O / ELF signature `file` prints for each name.
arch_pattern() {
  case "$1" in
    smurg-darwin-arm64) echo 'Mach-O 64-bit.*arm64' ;;
    smurg-darwin-x64) echo 'Mach-O 64-bit.*x86_64' ;;
    smurg-linux-x64) echo 'ELF 64-bit LSB.*x86-64' ;;
    smurg-linux-arm64) echo 'ELF 64-bit LSB.*(ARM aarch64|aarch64)' ;;
  esac
}

here="smurg-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/^aarch64$/arm64/' -e 's/^x86_64$/x64/')"
mkdir -p "$out"
: >"$out/SHA256SUMS.tmp"
for name in "${found[@]}"; do
  # A copy first: artifacts downloaded in CI lose their mode bits, and the original is left as it was.
  cp "$dist/$name" "$out/$name"
  chmod 755 "$out/$name"
  if [ "$check_arch" = 1 ]; then
    described="$(file -b "$out/$name")"
    [[ "$described" =~ $(arch_pattern "$name") ]] || { echo "release-assets: $name is not the executable its name says: $described" >&2; exit 1; }
  fi
  if [ "$name" = "$here" ]; then
    reported="$("$out/$name" --version)"
    [[ "$reported" == "smurg $version ("* ]] || { echo "release-assets: $name reports '$reported', not smurg $version" >&2; exit 1; }
    echo "release-assets: $name --version: $reported"
  fi
  if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$out/$name" | cut -d' ' -f1)"; else sum="$(shasum -a 256 "$out/$name" | cut -d' ' -f1)"; fi
  printf '%s  %s\n' "$sum" "$name" >>"$out/SHA256SUMS.tmp"
done
sort -k2 "$out/SHA256SUMS.tmp" >"$out/SHA256SUMS"
rm -f "$out/SHA256SUMS.tmp"
sed "s|^SMURG_RELEASE_BASE_URL=''\$|SMURG_RELEASE_BASE_URL='$base_url'|" scripts/install.sh >"$out/install.sh"
[ "$(grep -c "^SMURG_RELEASE_BASE_URL='$base_url'\$" "$out/install.sh")" = 1 ] || { echo 'release-assets: could not fill in the release URL' >&2; exit 1; }
chmod 755 "$out/install.sh"

if [ -n "$repo_url" ]; then
  # Release notes live on the releases page: a relative link of the changelog ([x](docs/X.md)) points at the file as
  # it is in this tag.
  section="$(printf '%s\n' "$section" | sed -E "s|\]\(([^):/#][^):]*)\)|](${repo_url}/blob/${tag}/\1)|g")"
fi

if [ -n "$notes" ]; then
  mkdir -p "$(dirname "$notes")"
  {
    printf '%s\n\n' "$section"
    printf '## 安裝\n\n'
    printf 'macOS（Apple silicon、Intel）與 Linux（x64、arm64，glibc）：\n\n'
    printf '```sh\n'
    if [ -n "$short_latest" ]; then
      printf '# 最新版本\ncurl -fsSL %s | sh\n' "$short_latest"
      printf '# 最新版本（連不上 smurg.ai 時：同一個檔案在 GitHub 上的網址）\ncurl -fsSL %s | sh\n' "$latest"
    elif [ -n "$latest" ]; then
      printf '# 最新版本\ncurl -fsSL %s | sh\n' "$latest"
    fi
    printf '# 這個版本（%s）\ncurl -fsSL %s/install.sh | sh\n' "$version" "$base_url"
    printf '```\n\n'
    # shellcheck disable=SC2016 # Markdown backticks, not a command substitution
    printf '安裝程式只安裝 sha256 與下面的 `SHA256SUMS` 相符的執行檔。\n\n'
    printf '```\n'
    cat "$out/SHA256SUMS"
    printf '```\n'
  } >"$notes"
  echo "release-assets: notes $notes"
fi

echo "release-assets: $out"
cat "$out/SHA256SUMS"
[ -z "$short_latest" ] || echo "install the latest release with:  curl -fsSL $short_latest | sh"
[ -z "$latest" ] || echo "install the latest release with:  curl -fsSL $latest | sh"
echo "install this release with:  curl -fsSL $base_url/install.sh | sh"
