#!/usr/bin/env bash
# Link this plugin into Herdr as a dev plugin (idempotent).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec herdr plugin link "$DIR"
