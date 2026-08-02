# comment-fmt

A CLI that reformats comments in JavaScript/TypeScript, CSS/SCSS, HTML, and Astro: wraps overflowing
lines to a fixed width and normalises multi-line block comment shape. Meant to run from a pre-commit
hook.

## Status

Not yet published to npm (`package.json` stays at `0.0.0` deliberately -- see [`PLAN.md`](PLAN.md)'s
Status section). Everything below works today from source.

JS/TS/JSX/TSX, CSS/SCSS, HTML, and Astro comment wrapping all work via the programmatic API:

```ts
import {format} from 'comment-fmt';

format(source, {lang: 'js'}); // 'js' | 'css' | 'html' | 'astro', defaults to 'js'
// reflows over-width // and /* */ comments; everything else is untouched
```

...and via the CLI. With no file arguments it discovers every tracked file via `git ls-files` (not a
directory walk -- a trailing `.` is treated as one explicit, literal file path, which matches nothing
and silently no-ops, so don't pass one):

```bash
comment-fmt --check   # exit 1 if any tracked file would change
comment-fmt --write   # rewrite over-width comments in place
comment-fmt --diff    # print what would change, without writing
```

Or pass explicit files (the pre-commit hook path -- `lint-staged` already filtered to staged files, so
no discovery happens):

```bash
comment-fmt --write src/foo.ts src/bar.css
```

Block shape is a one-way ratchet: a single-line comment expands to the starred multi-line form when it
overflows, but a multi-line comment that already fits is never collapsed back down, no matter how short
its content is -- the tool only ever rescues overflow. An optional `comment-fmt.json` (`maxLength`,
`targetLength`, `ignore`, `extraDirectives`) tunes behavior; most repos need no file at all. See
[`PLAN.md`](PLAN.md) §12 for the phase breakdown and current rollout status.

## Development

- Install dependencies:

```bash
vp install
```

- Run the unit tests:

```bash
vp test
```

- Build the library:

```bash
vp pack
```

## Known issues

`vp test` currently fails on any fresh `vp create` scaffold, not just this repo: the `vitest`
package it resolves to (aliased via the standard Vite+ `overrides` mechanism to
`@voidzero-dev/vite-plus-test@latest`) is published to npm with no `bin` entry, so `vp test` can't
find an entry point to invoke. Confirmed against the npm registry directly and reproduced across
multiple `vite-plus` versions — this isn't a config issue in this repo. CI runs the `test` job with
`continue-on-error` until upstream fixes it; there is no local workaround today.
