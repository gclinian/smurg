#!/usr/bin/env bash
# The files of one smurg release, ready for scripts/publish-downloads.sh (docs/RELEASING.md; .github/workflows/release.yml
# runs it):
#
#   scripts/release-assets.sh --version X.Y.Z [--base-url https://…] [--dist DIR] [--out DIR] [--notices FILE]
#                             [--require-all] [--check-arch] [--notes FILE] [--changelog FILE]
#   scripts/release-assets.sh --version X.Y.Z --check-changelog [--changelog FILE]
#   scripts/release-assets.sh --version X.Y.Z --publish-checks [--changelog FILE]
#
# Takes every <dist>/smurg-<platform>-<arch> (default dist: packages/cli/dist) that scripts/build-sea.sh --version X.Y.Z
# built, each on its own platform, and the third-party notices, and writes into <out> (default
# packages/cli/dist/release/X.Y.Z):
#   smurg-<platform>-<arch>   the executables (0755)
#   SHA256SUMS                their sha256 (what scripts/install.sh verifies before installing)
#   install.sh                scripts/install.sh with the download location filled in (0755)
#   THIRD-PARTY-NOTICES.txt   the licenses of the third-party software in the executables (0644, from --notices)
# Those are exactly the files of https://downloads.smurg.ai/vX.Y.Z/ (Cloudflare R2; a person uploads them with
# scripts/publish-downloads.sh, never CI). The asset names are the ones scripts/install.sh downloads: smurg-darwin-arm64,
# smurg-darwin-x64, smurg-linux-x64, smurg-linux-arm64. The base URL, default https://downloads.smurg.ai/vX.Y.Z, is
# baked into install.sh, so the copy publish-downloads puts at https://downloads.smurg.ai/latest/install.sh (where
# https://smurg.ai/install.sh redirects) installs the executables of its own version. The one install line people are
# given is `curl -fsSL https://smurg.ai/install.sh | sh`.
#
#   --notices FILE  the third-party notices of this build (default <dist>/THIRD-PARTY-NOTICES.txt, which
#                  scripts/build-sea.sh writes next to the executable). Required: the assembly refuses without it, and
#                  refuses a file that is empty, does not mention node-pty, @parcel/watcher,
#                  @anthropic-ai/sandbox-runtime and Node.js (what the executables bundle), or is not complete: the
#                  committed packages/cli/THIRD-PARTY-NOTICES.txt (its Node.js section is a placeholder), or a file
#                  without exactly one line `node@X.Y.Z (the Node.js runtime)` and the Node.js LICENSE
#   --require-all  refuse unless all four executables are there (a release; without it any subset is taken)
#   --check-arch   check with `file` that each executable is the Mach-O / ELF of its name's architecture
#   --notes FILE   write the release notes (the private GitHub release, the internal record): the CHANGELOG section
#                  of this version (refused when there is none), the install line and the checksums
#   --changelog F  the changelog to read (default CHANGELOG.md)
#   --check-changelog  only check that the changelog has a section for X.Y.Z (and that the version is valid), print
#                  it and stop: the release workflow runs this before building anything
#   --publish-checks  only check what a PUBLISHED release needs filled in (docs/RELEASING.md §3, §4), print every
#                  problem and stop (exit 1 on any): the section's heading has a date (`## [X.Y.Z] - YYYY-MM-DD`, not
#                  `Unreleased`); no placeholder (<RELAY_URL>, <account-subdomain>) is left in the section or in the
#                  user docs; DEFAULT_RELAY_URL (packages/cli/src/relay/default-relay.ts) is an https origin, since
#                  every binary keeps its built-in relay forever, and the user docs (README.md, docs/HOSTING.md,
#                  docs/JOINING.md) name that same relay and show the install line
#                  `curl -fsSL https://smurg.ai/install.sh | sh`; neither they nor the section name a concrete
#                  *.workers.dev address other than the built-in relay (a stale address of the shared relay; a
#                  self-hosted one is written with a <placeholder>); nothing users read links to the private GitHub
#                  repository (github.com/gclinian/smurg in those docs, the section, apps/site/public, the web app's
#                  index.html, src/ and public/); LICENSE names its copyright holder (no `<COPYRIGHT HOLDER>`) and is
#                  not the Apache License any more; every package.json says version X.Y.Z (without a pre-release
#                  part), "license": "UNLICENSED" and "private": true; scripts/install.sh (every release ships it, and a
#                  published one is never replaced) neither offers a relay of one's own nor calls smurg open source.
#                  The release workflow runs it before building: it fails a tag, and only warns in a dry run.
# Every executable must carry the build marker `smurg-build-version=X.Y.Z;` of this version (scripts/build-sea.sh writes
# it) and the download URL of the Node.js release whose LICENSE the notices carry
# (https://nodejs.org/download/release/vA.B.C/ next to `node@A.B.C (the Node.js runtime)`), so an executable of another
# version or another Node.js cannot be mixed into a release (scripts/release-markers.ts; docs/RELEASING.md §4.3). The
# executable for this machine, if present, is run once: it must report exactly `smurg X.Y.Z (… node A.B.C)`.
# Nothing is uploaded or signed here.
set -euo pipefail
cd "$(dirname "$0")/.."

version=''
base_url=''
dist='packages/cli/dist'
out=''
notices=''
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
    --notices) need "$@"; notices="$2"; shift 2 ;;
    --notes) need "$@"; notes="$2"; shift 2 ;;
    --changelog) need "$@"; changelog="$2"; shift 2 ;;
    --require-all) require_all=1; shift ;;
    --check-arch) check_arch=1; shift ;;
    --check-changelog) check_changelog=1; shift ;;
    --publish-checks) publish_checks=1; shift ;;
    -h | --help) sed -n '2,57p' "$0"; exit 0 ;;
    *) echo "release-assets: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ "$version" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$ ]] || { echo 'release-assets: --version X.Y.Z is required (no leading v)' >&2; exit 2; }
# Where the files are served: the version's own prefix on the downloads domain (docs/RELEASING.md "The plan").
downloads='https://downloads.smurg.ai'
install_line='curl -fsSL https://smurg.ai/install.sh | sh'
base_url="${base_url:-$downloads/v$version}"
[[ "$base_url" =~ ^https://[A-Za-z0-9._~%/:-]+$ ]] || { echo 'release-assets: --base-url must be an https URL' >&2; exit 2; }
base_url="${base_url%/}"
out="${out:-packages/cli/dist/release/$version}"
notices="${notices:-$dist/THIRD-PARTY-NOTICES.txt}"

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

section=''
if [ -n "$notes" ] || [ "$check_changelog" = 1 ] || [ "$publish_checks" = 1 ]; then
  [ -f "$changelog" ] || { echo "release-assets: $changelog not found" >&2; exit 1; }
  section="$(changelog_part section | sed -e '/./,$!d' | awk '{ lines[NR] = $0 } END { n = NR; while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }')"
  [ -n "$section" ] || { echo "release-assets: $changelog has no section for $version (a heading like '## [$version]')" >&2; exit 1; }
fi
if [ "$publish_checks" = 1 ]; then
  problems=()
  user_docs=(README.md docs/HOSTING.md docs/JOINING.md)
  heading="$(changelog_part heading)"
  [[ "$heading" =~ \ -\ [0-9]{4}-[0-9]{2}-[0-9]{2}([[:space:]]|$) ]] || problems+=("$changelog: the heading '$heading' has no release date (## [$version] - YYYY-MM-DD)")
  placeholders='<RELAY_URL>|<account-subdomain>|<這個網址>'
  if printf '%s\n' "$section" | grep -Eq "$placeholders"; then problems+=("$changelog: the $version section still has a placeholder ($placeholders)"); fi
  for doc in "${user_docs[@]}"; do
    if [ -f "$doc" ] && grep -Eq "$placeholders" "$doc"; then problems+=("$doc still has a placeholder ($placeholders): docs/RELEASING.md §3"); fi
  done
  default_relay=packages/cli/src/relay/default-relay.ts
  grep -Eq "^export const DEFAULT_RELAY_URL: string \| null = 'https://[a-z0-9.-]+';" "$default_relay" ||
    problems+=("$default_relay: DEFAULT_RELAY_URL is not the deployed relay's https origin (docs/RELEASING.md §3): a binary keeps its built-in relay forever")
  relay_url="$(sed -n "s#^export const DEFAULT_RELAY_URL: string | null = '\(https://[a-z0-9.-]*\)';\$#\1#p" "$default_relay")"
  if [ -n "$relay_url" ]; then
    for doc in "${user_docs[@]}"; do
      [ -f "$doc" ] && grep -qF "$relay_url" "$doc" ||
        problems+=("$doc does not name the built-in relay $relay_url (DEFAULT_RELAY_URL): the docs must say what the binary uses")
    done
  fi
  for doc in "${user_docs[@]}"; do
    [ -f "$doc" ] && grep -qF "$install_line" "$doc" ||
      problems+=("$doc does not show the install line  $install_line")
  done
  # The official relay is DEFAULT_RELAY_URL; any other concrete workers.dev address in what users read is a stale one
  # (the shared relay left workers.dev on 2026-10-01). A self-hosted relay's address is written with a placeholder
  # (https://smurg-relay.<你的子網域>.workers.dev), which this does not match.
  stale_workers_dev() { { grep -Eo 'https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.workers\.dev' | sort -u | grep -vxF "${relay_url:-none}" | tr '\n' ' '; } || true; }
  for doc in "${user_docs[@]}"; do
    [ -f "$doc" ] || continue
    stale="$(stale_workers_dev < "$doc")"
    [ -z "$stale" ] || problems+=("$doc names a workers.dev address that is not the built-in relay: ${stale% } (docs/RELEASING.md §3)")
  done
  stale="$(printf '%s\n' "$section" | stale_workers_dev)"
  [ -z "$stale" ] || problems+=("$changelog: the $version section names a workers.dev address that is not the built-in relay: ${stale% }")
  # The source is private (decided 2026-10-01): a link to the repository is a 404 for everyone else. What users read:
  # the user docs, this version's notes, the product page and the web app (its index.html, strings and static files).
  repo_link='github\.com[/:]gclinian/smurg'
  repo_problem='names the GitHub repository (github.com/gclinian/smurg), which is private: nobody else can open it (docs/RELEASING.md §4)'
  for doc in "${user_docs[@]}"; do
    if [ -f "$doc" ] && grep -Eiq "$repo_link" "$doc"; then problems+=("$doc $repo_problem"); fi
  done
  if printf '%s\n' "$section" | grep -Eiq "$repo_link"; then problems+=("$changelog: the $version section $repo_problem"); fi
  for tree in apps/site/public apps/web/src apps/web/public apps/web/index.html; do
    [ -e "$tree" ] || continue
    while IFS= read -r file; do
      [ -z "$file" ] || problems+=("$file $repo_problem")
    done < <(grep -rEIil --exclude-dir=node_modules "$repo_link" "$tree" | sort || true)
  done
  # LICENSE: proprietary since 2026-10-01; the owner names the holder (docs/RELEASING.md "The plan", §6.1).
  if [ ! -f LICENSE ]; then
    problems+=('LICENSE is missing')
  else
    if grep -qF '<COPYRIGHT HOLDER>' LICENSE; then problems+=('LICENSE still has the placeholder <COPYRIGHT HOLDER>: the owner names the copyright holder first (docs/RELEASING.md §6.1, docs/OPEN-QUESTIONS.md Q14)'); fi
    if [ "$(sed -n '/[^[:space:]]/{s/^[[:space:]]*//;s/[[:space:]]*$//;p;q;}' LICENSE)" = 'Apache License' ]; then problems+=('LICENSE is still the Apache License 2.0 (smurg is proprietary since 2026-10-01)'); fi
  fi
  # The installer: every release ships it, and a published one is never replaced. With the source private nobody outside
  # the project can run a relay of their own, and smurg is not open source (decided 2026-10-01).
  retired='自己架設|自架|self-host|open[ -]?source|開源|開放原始碼|apache'
  if [ -f scripts/install.sh ] && grep -Eiq "$retired" scripts/install.sh; then
    problems+=("scripts/install.sh offers a relay of one's own or calls smurg open source (line $(grep -Ein "$retired" scripts/install.sh | cut -d: -f1 | head -3 | tr '\n' ' ' | sed 's/ $//')): the source is private (docs/RELEASING.md \"The plan\")")
  fi
  for pkg in package.json apps/*/package.json packages/*/package.json tests/*/package.json; do
    [ -f "$pkg" ] || continue
    pkg_version="$(sed -n 's/^  "version": "\([^"]*\)",\{0,1\}$/\1/p' "$pkg" | head -1)"
    [ "$pkg_version" = "${version%%-*}" ] || problems+=("$pkg: version '$pkg_version', not ${version%%-*} (smurg --version prints the daemon's)")
    grep -Eq '^  "license": "UNLICENSED",?$' "$pkg" || problems+=("$pkg: \"license\" is not \"UNLICENSED\" (npm's value for proprietary code)")
    grep -Eq '^  "private": true,?$' "$pkg" || problems+=("$pkg: not \"private\": true (nothing is ever published to npm)")
  done
  if [ "${#problems[@]}" -gt 0 ]; then
    echo "release-assets: $version is not ready to publish:" >&2
    printf '  - %s\n' "${problems[@]}" >&2
    exit 1
  fi
  echo "release-assets: $version is ready to publish (dated changelog section, no placeholders, built-in relay set and named in the docs, install line, no stale workers.dev address, no link to the private repository, LICENSE holder named, the installer's wording, package versions and license fields)"
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

# The third-party notices are part of every release (the license terms of what the executables bundle must travel with
# them): refuse before anything is written.
[ -f "$notices" ] || { echo "release-assets: $notices is missing: THIRD-PARTY-NOTICES.txt (the licenses of the third-party software in the executables) is part of every release; give it with --notices FILE (docs/RELEASING.md §4)" >&2; exit 1; }
[ -s "$notices" ] || { echo "release-assets: $notices is empty" >&2; exit 1; }
unmentioned=()
for component in node-pty @parcel/watcher @anthropic-ai/sandbox-runtime Node.js; do
  grep -qF -- "$component" "$notices" || unmentioned+=("$component")
done
[ "${#unmentioned[@]}" = 0 ] || { echo "release-assets: $notices does not mention ${unmentioned[*]} (bundled in every executable): not the notices of this build?" >&2; exit 1; }
# Complete: the committed packages/cli/THIRD-PARTY-NOTICES.txt has only a placeholder where scripts/build-sea.sh puts the
# LICENSE of the Node.js the executables are copies of.
if grep -qF 'In the copy of this file that is built' "$notices"; then
  echo "release-assets: $notices is the committed packages/cli/THIRD-PARTY-NOTICES.txt, whose Node.js section is still the placeholder: give the THIRD-PARTY-NOTICES.txt that scripts/build-sea.sh wrote next to the executables (docs/RELEASING.md §4.3)" >&2
  exit 1
fi
notices_node="$(sed -n 's/^node@\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\) (the Node\.js runtime)$/\1/p' "$notices")"
if [ -z "$notices_node" ] || [ "$(printf '%s\n' "$notices_node" | grep -c .)" != 1 ] || ! grep -qF 'Node.js is licensed for use as follows:' "$notices"; then
  echo "release-assets: $notices has no complete Node.js section (exactly one line 'node@X.Y.Z (the Node.js runtime)' and the Node.js LICENSE after it): not the notices scripts/build-sea.sh writes" >&2
  exit 1
fi

# What each executable says about itself without running it (only this machine's one can run here): the build marker
# scripts/build-sea.sh writes into the program, and the download URL of the Node.js release it is a copy of
# (scripts/release-markers.ts). A release assembled by hand (docs/RELEASING.md §4.3) cannot take in an executable of
# another version, or one built on another Node.js than the one whose LICENSE the notices carry.
build_versions_of() {
  { LC_ALL=C grep -aoE 'smurg-build-version=[0-9A-Za-z.-]{1,60};' "$1" || true; } | sed -e 's/^smurg-build-version=//' -e 's/;$//' | sort -u | tr '\n' ' ' | sed 's/ $//'
}
node_versions_of() {
  { LC_ALL=C grep -aoE 'https://nodejs\.org/download/release/v[0-9]+\.[0-9]+\.[0-9]+/' "$1" || true; } | sed -e 's#^https://nodejs\.org/download/release/v##' -e 's#/$##' | sort -u | tr '\n' ' ' | sed 's/ $//'
}
marker_problems=()
for name in "${found[@]}"; do
  built="$(build_versions_of "$dist/$name")"
  [ "$built" = "$version" ] || marker_problems+=("$name was built as smurg ${built:-(no build marker smurg-build-version=…; in it)}, not $version (scripts/build-sea.sh --version $version)")
  node="$(node_versions_of "$dist/$name")"
  [ "$node" = "$notices_node" ] || marker_problems+=("$name is Node.js ${node:-(none: no https://nodejs.org/download/release/v…/ in it)}, but the notices have the LICENSE of Node.js $notices_node")
done
if [ "${#marker_problems[@]}" -gt 0 ]; then
  echo "release-assets: these are not the executables of smurg $version that go with $notices:" >&2
  printf '  - %s\n' "${marker_problems[@]}" >&2
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
    reported_node="$(printf '%s\n' "$reported" | sed -n 's/^smurg .*[ (]node \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\))$/\1/p')"
    [ "$reported_node" = "$notices_node" ] || { echo "release-assets: $name reports '$reported': not Node.js $notices_node, whose LICENSE the notices carry" >&2; exit 1; }
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
if [ "$(cd "$(dirname "$notices")" && pwd -P)/$(basename "$notices")" != "$(cd "$out" && pwd -P)/THIRD-PARTY-NOTICES.txt" ]; then
  cp "$notices" "$out/THIRD-PARTY-NOTICES.txt"
fi
chmod 644 "$out/THIRD-PARTY-NOTICES.txt"

if [ -n "$notes" ]; then
  mkdir -p "$(dirname "$notes")"
  {
    printf '%s\n\n' "$section"
    printf '## 安裝\n\n'
    printf 'macOS（Apple silicon、Intel）與 Linux（x64、arm64，glibc）：\n\n'
    printf '```sh\n%s\n```\n\n' "$install_line"
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
echo "publish (a person, docs/RELEASING.md §4):  scripts/publish-downloads.sh --version $version --dist $out"
echo "this version's installer:  curl -fsSL $base_url/install.sh | sh"
echo "the install line (the latest published version):  $install_line"
