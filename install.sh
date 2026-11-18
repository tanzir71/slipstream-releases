#!/bin/bash
# Install or update Slipstream for macOS from the latest GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/tanzir71/slipstream-releases/main/install.sh | bash
#
# It reads the release's latest.json, downloads slipstream-macos.zip from this repository's GitHub releases only,
# checks it against the SHA-256 in latest.json, checks the app's bundle id, code signature and CPU, and copies it to
# /Applications (or ~/Applications when that isn't writable). The previous copy goes to the Trash.
#
# Files downloaded with curl aren't quarantined, so macOS opens the app without the "unidentified developer" /
# "Open Anyway" step a browser download needs (Slipstream isn't notarized: that needs Apple's paid program).
# Nothing about you or your Mac is sent; it's two HTTPS downloads from github.com.
#
# Testing: SLIPSTREAM_RELEASE_URL=file:///path/to/fake-release  SLIPSTREAM_INSTALL_DIR=/tmp/x  SLIPSTREAM_NO_OPEN=1
set -euo pipefail

REPO="tanzir71/slipstream-releases"
BASE="${SLIPSTREAM_RELEASE_URL:-https://github.com/$REPO/releases/latest/download}"
PROTO='=https'
[ -n "${SLIPSTREAM_RELEASE_URL:-}" ] && PROTO='=https,file'
BUNDLE_IDS="com.tanziro.slipstream"

say() { printf '%s\n' "$*"; }
die() { printf 'Slipstream install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS."
os="$(sw_vers -productVersion)"
[ "${os%%.*}" -ge 26 ] || die "Slipstream needs macOS 26 or later; this Mac has $os."

tmp="$(mktemp -d "${TMPDIR:-/tmp}/slipstream-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

say "› Reading the latest release…"
curl -fsSL --proto "$PROTO" "$BASE/latest.json" -o "$tmp/latest.json" \
  || die "couldn't read latest.json from $BASE. Is a release published yet?"
get() { plutil -extract "$1" raw -o - "$tmp/latest.json" 2>/dev/null; }
published="$(get published || echo false)"
[ "$published" = "true" ] || [ "$published" = "1" ] || [ -n "${SLIPSTREAM_ALLOW_UNPUBLISHED:-}" ] \
  || die "the latest release isn't published yet."
version="$(get version || echo '?')"

url="" sha="" size=""
i=0
while name="$(get "assets.macos.$i.name")"; do
  if [ "$name" = "slipstream-macos.zip" ]; then
    url="$(get "assets.macos.$i.url" || true)"; sha="$(get "assets.macos.$i.sha256" || true)"; size="$(get "assets.macos.$i.size" || true)"
    break
  fi
  i=$((i + 1))
done
[ ${#sha} -eq 64 ] || die "latest.json has no macOS zip with a SHA-256."
if [ -n "${SLIPSTREAM_RELEASE_URL:-}" ]; then
  url="$BASE/slipstream-macos.zip"
else
  case "$url" in https://github.com/$REPO/releases/download/*) ;; *) die "unexpected download address in latest.json: $url" ;; esac
fi

mb=""; [ -n "$size" ] && mb=" ($((size / 1048576)) MB)"
say "› Downloading Slipstream $version$mb…"
curl -fL --proto "$PROTO" --progress-bar "$url" -o "$tmp/slipstream-macos.zip" || die "download failed."
got="$(shasum -a 256 "$tmp/slipstream-macos.zip" | cut -d' ' -f1)"
[ "$got" = "$sha" ] || die "the download doesn't match latest.json (SHA-256 $got, expected $sha). Nothing was installed."

say "› Checking the app…"
ditto -x -k "$tmp/slipstream-macos.zip" "$tmp/x"
app="$tmp/x/Slipstream.app"
[ -d "$app" ] || die "the zip doesn't contain Slipstream.app."
id="$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
case " $BUNDLE_IDS " in *" $id "*) ;; *) die "unexpected app in the zip (bundle id '$id')." ;; esac
codesign --verify --deep --strict "$app" 2>/dev/null || die "the app's code signature is broken. Nothing was installed."
arch="$(uname -m)"
lipo -archs "$app/Contents/MacOS/Slipstream" 2>/dev/null | tr ' ' '\n' | grep -qx "$arch" \
  || die "this build doesn't run on $arch Macs."
signer="$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
say "  signed by: ${signer:-ad-hoc signature (built locally)}"

dest="${SLIPSTREAM_INSTALL_DIR:-/Applications}"
if [ -z "${SLIPSTREAM_INSTALL_DIR:-}" ] && [ ! -w "$dest" ]; then dest="$HOME/Applications"; fi
mkdir -p "$dest"
if pgrep -xq Slipstream && [ -z "${SLIPSTREAM_INSTALL_DIR:-}" ]; then die "quit Slipstream first, then run this again."; fi
if [ -e "$dest/Slipstream.app" ]; then
  trash="$HOME/.Trash"; [ -n "${SLIPSTREAM_INSTALL_DIR:-}" ] && trash="$dest/.trash"
  mkdir -p "$trash"
  mv "$dest/Slipstream.app" "$trash/Slipstream $(date +%Y-%m-%d\ %H.%M.%S).app"
  say "  the previous version is in the Trash"
fi
ditto "$app" "$dest/Slipstream.app"
xattr -dr com.apple.quarantine "$dest/Slipstream.app" 2>/dev/null || true

say "✓ Installed Slipstream $version in $dest"
[ -n "${SLIPSTREAM_NO_OPEN:-}" ] || open "$dest/Slipstream.app"
