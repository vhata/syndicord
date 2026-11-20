#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# npm's prepare lifecycle builds the package and installs this checkout's hooks.
exec npm ci
