#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ICON_DIR="$ROOT_DIR/icons"
ASSET_DIR="$ROOT_DIR/assets"

OPENAI_SOURCE="$ASSET_DIR/openai-logo.png"
ANTHROPIC_SOURCE="$ASSET_DIR/anthropic-logo.svg"

if ! command -v magick >/dev/null 2>&1; then
  echo "magick is required to generate icons." >&2
  exit 1
fi

if [[ ! -f "$OPENAI_SOURCE" ]]; then
  echo "Missing $OPENAI_SOURCE" >&2
  exit 1
fi

if [[ ! -f "$ANTHROPIC_SOURCE" ]]; then
  echo "Missing $ANTHROPIC_SOURCE" >&2
  exit 1
fi

mkdir -p "$ICON_DIR"

codex_colors=(
  "#10A37F"
  "#2563EB"
  "#F59E0B"
  "#EF4444"
)

claude_colors=(
  "#D97757"
  "#DB2777"
  "#7C3AED"
  "#0F766E"
)

for index in 1 2 3 4; do
  codex_color="${codex_colors[$((index - 1))]}"
  claude_color="${claude_colors[$((index - 1))]}"
  tmp_svg="$(mktemp)"

  magick "$OPENAI_SOURCE" \
    -alpha on \
    -fill "$codex_color" \
    -colorize 100 \
    -trim \
    -resize 384x384 \
    -gravity center \
    -background none \
    -extent 512x512 \
    "$ICON_DIR/codex-${index}.png"

  sed "s/fill=\"#d97757\"/fill=\"$claude_color\"/g" "$ANTHROPIC_SOURCE" > "$tmp_svg"
  magick -background none "$tmp_svg" \
    -trim \
    -resize 384x384 \
    -gravity center \
    -extent 512x512 \
    "$ICON_DIR/claude-${index}.png"

  rm -f "$tmp_svg"
done
