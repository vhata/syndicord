#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

printf '%s\n' '==> Source checks'
npm run check

printf '%s\n' '==> Installed-package checks'
npm run test:package

printf '%s\n' '==> Website checks (domain root)'
SITE_BASE_PATH=/ npm run site:check

printf '%s\n' '==> Website checks (GitHub project path)'
SITE_BASE_PATH=/syndicord/ npm run site:check
