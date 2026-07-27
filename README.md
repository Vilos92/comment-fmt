# comment-fmt

A CLI that reformats comments in JavaScript/TypeScript, CSS/SCSS, and HTML: wraps overflowing lines to a
fixed width and normalises multi-line block comment shape. Meant to run from a pre-commit hook.

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
