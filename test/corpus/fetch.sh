#!/usr/bin/env bash
# Single source of truth for the differential-corpus repo list, so repeated local runs always scan
# the same corpus. Deliberately local-only: this is not wired into any CI job. Shallow-clones each
# repo into ./corpus/ (fast, small, and git-ignored: this is ephemeral scratch data, never
# committed).
#
# Usage:
#   ./test/corpus/fetch.sh
#   bun test/corpus/run.ts corpus/* node_modules
set -euo pipefail

cd "$(dirname "$0")/../.."

# A deliberately modest list: clone time/disk trades off against corpus diversity. This tool's own
# real-world consumer repos are deliberately absent here too: those are separate private/personal
# repos, so scanning them is a manual step outside this script, pointed directly at wherever they
# already live on disk.
REPOS=(
  microsoft/TypeScript
  vuejs/core
  rollup/rollup
  vitejs/vite
  eslint/eslint
  facebook/react
  sveltejs/svelte
  prettier/prettier
  webpack/webpack
  babel/babel
  lodash/lodash
  expressjs/express
  colinhacks/zod
  date-fns/date-fns
  jestjs/jest
)

mkdir -p corpus
for repo in "${REPOS[@]}"; do
  name="${repo##*/}"
  if [ -d "corpus/${name}/.git" ]; then
    echo "already present, skipping: ${name}"
    continue
  fi
  echo "cloning ${repo} -> corpus/${name}"
  git clone --depth 1 --quiet "https://github.com/${repo}.git" "corpus/${name}"
done
