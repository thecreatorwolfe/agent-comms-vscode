#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d icons ]]; then
  echo "icons directory missing" >&2
  exit 1
fi

echo "GitHub Pages workflow publishes the icons/ directory."
echo "Push to main or trigger .github/workflows/pages.yml."
