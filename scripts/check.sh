#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

printf '%s\n' '==> Source checks'
npm run check

printf '%s\n' '==> Installed-package checks'
npm run test:package
