#!/usr/bin/env bash
# Fetch the ffmpeg + ffprobe static binaries into layers/ffmpeg/bin/.
# These are Linux x86_64 builds from John Van Sickle's public releases
# (johnvansickle.com/ffmpeg — the community-standard static ffmpeg).
#
# Run once before `cdk deploy` — the CDK's ffmpeg Lambda layer bundles
# these binaries from the local filesystem, so they must exist before
# synth. Binaries are gitignored (76 MB each) — this script populates
# them idempotently.
#
# Usage: ./scripts/fetch-ffmpeg-layer.sh
#        or: npm run fetch:ffmpeg

set -euo pipefail

LAYER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/layers/ffmpeg"
BIN_DIR="$LAYER_DIR/bin"
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"

if [[ -x "$BIN_DIR/ffmpeg" && -x "$BIN_DIR/ffprobe" ]]; then
  echo "ffmpeg + ffprobe already present in $BIN_DIR"
  exit 0
fi

mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ffmpeg-release-amd64-static.tar.xz (~40 MB)..."
curl -sL --fail "$FFMPEG_URL" -o "$TMP/ffmpeg.tar.xz"

echo "Extracting..."
tar xf "$TMP/ffmpeg.tar.xz" -C "$TMP"
SRC_DIR="$(find "$TMP" -maxdepth 1 -type d -name 'ffmpeg-*-amd64-static' | head -1)"

echo "Installing to $BIN_DIR..."
cp "$SRC_DIR/ffmpeg"  "$BIN_DIR/ffmpeg"
cp "$SRC_DIR/ffprobe" "$BIN_DIR/ffprobe"
chmod +x "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe"

echo "Done. Binaries installed:"
ls -lh "$BIN_DIR"
