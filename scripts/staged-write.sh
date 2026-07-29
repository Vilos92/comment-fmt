#!/usr/bin/env bash
# Wraps `comment-fmt --write` for the pre-commit hook (vite.config.ts's `staged` config), filtering
# out test/fixtures/** paths before invoking it.
#
# Fixture pairs are curated test data, not source -- the same reasoning vite.config.ts's own
# fmt/lint ignorePatterns already apply to oxfmt/oxlint. But `comment-fmt --write` itself has no
# such exclusion when given explicit file arguments: the `ignore` config option only filters
# *discovery* (plan §6), deliberately, so a file named explicitly is always processed regardless.
# lint-staged feeds every staged file as an explicit argument, bypassing that discovery-only
# exclusion entirely, so this filter has to happen here instead, one layer up.
#
# The match pattern is `*/test/fixtures/*`, not `test/fixtures/*`: lint-staged passes every staged
# path as an *absolute* path by default (confirmed directly, not assumed -- a `test/fixtures/*`-only
# pattern here matched nothing at all, since an absolute path like
# `/Users/name/project/test/fixtures/js/foo.js` never starts with the literal string
# `test/fixtures/`). The leading `*/` makes the match work regardless of how much absolute prefix
# precedes it.
#
# Confirmed live, not theoretical: a short multi-line fixture staged and run through the
# unfiltered hook came back silently rewritten, exactly the class of corruption this exists to
# prevent (a fixture's `.input`/`.expected` pair is supposed to represent original, hand-reviewed
# intent, not whatever the tool being tested happened to do to it at commit time).
set -euo pipefail

cd "$(dirname "$0")/.."

files=()
for f in "$@"; do
  case "$f" in
    */test/fixtures/*) continue ;;
    *) files+=("$f") ;;
  esac
done

if [ "${#files[@]}" -gt 0 ]; then
  bun src/cli/index.ts --write "${files[@]}"
fi
