#!/bin/bash
# This trusted copy is installed by an administrator, not executed from release archives.
set -euo pipefail
exec python3 "$(dirname "$0")/release.py" "$@"
