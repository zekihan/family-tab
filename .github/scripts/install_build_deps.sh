#!/bin/sh
# Install frontend dependencies from the committed lockfile with lifecycle
# scripts disabled. make lint checks the Linux lockfile entries with install
# scripts against the exact approvals in web/package.json.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
cd "$ROOT"
case ${1-} in ''|-f) ;; *) echo "Usage: $0 [-f]" >&2; exit 1 ;; esac
npm ci --prefix web --ignore-scripts
