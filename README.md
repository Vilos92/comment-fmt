# comment-fmt

[![npm version](https://img.shields.io/npm/v/comment-fmt.svg)](https://www.npmjs.com/package/comment-fmt)
[![CI](https://github.com/Vilos92/comment-fmt/actions/workflows/continuous-integration.yaml/badge.svg)](https://github.com/Vilos92/comment-fmt/actions/workflows/continuous-integration.yaml)

Wraps over-width comments to a fixed line length and normalizes block-comment shape, for
JS/TS/JSX/TSX, CSS/SCSS, HTML, and Astro. Runs from a pre-commit hook, next to whatever formatter
you already use.

```bash
npm install --save-dev comment-fmt
```

## Before / after

```diff
-/** Retries a flaky network call up to `maxAttempts` times, doubling the delay between each attempt before giving up. */
+/**
+ * Retries a flaky network call up to `maxAttempts` times, doubling the delay
+ * between each attempt before giving up.
+ */
 export function withRetry(fn: () => Promise<void>, maxAttempts = 3) {
```

Everything else about the comment is untouched. Wording, directive comments, hand-aligned tables,
ASCII diagrams — none of it is `comment-fmt`'s business. It only ever acts on a comment that's
already over the width limit.

## Why this exists

A human writing a comment by hand tends to eyeball the column and self-wrap as they go. Generated
code often doesn't — nothing in an LLM's token-by-token output is tracking where the print width
falls, so comments routinely blow past it or wrap unevenly. `comment-fmt` turns that into a
deterministic fix instead of a recurring note in review.

It isn't only for generated code. Anyone who wants a hard width limit enforced without hand-wrapping
gets the same benefit, regardless of who wrote the comment.

## What it does

- **Width.** No comment line exceeds `maxLength` (110 by default). A line that's too long gets
  wrapped.
- **Block shape.** A multi-line block comment never carries content on its opening (`/**`, `/*`,
  `<!--`) or closing (`*/`, `-->`) line. One-way ratchet: a comment collapses to a single line if it
  fits, expands to a starred (JS/CSS) or plain-indented (HTML/Astro) block if it doesn't, and once
  expanded it stays expanded even if a later edit shortens the content.
- **Directive-aware.** `eslint-disable`, `@ts-expect-error`, `prettier-ignore`, `biome-ignore`, and
  the rest of the usual tool directives are left alone even when they overflow, so wrapping one can
  never silently change what it disables.
- **Structure-aware.** Hand-aligned tables, ASCII/box-drawing diagrams, and fenced code blocks
  inside JSDoc are detected and passed through untouched.
- **Multi-language.** JS, TS, JSX, TSX, CSS, SCSS, HTML, and Astro (frontmatter and template both)
  in one tool.

### Why it's safe on hand-formatted content

The tool never inspects a comment that already fits. That single gate does most of the safety work:
nearly every hand-aligned table, box diagram, or deliberate line break in a real codebase already
sits under the width limit, so it's never touched in the first place. The table/diagram heuristics
only have to catch the rare over-width case, a much smaller and more forgiving problem than trying
to correctly classify every structure a human might invent.

<details>
<summary>Two edge cases worth knowing about</summary>

**A trailing `// comment` that's still too long after wrapping is left as one over-width line,
never split.** Splitting it would put a `//`-only continuation right where the next statement's own
leading comment could plausibly sit, genuinely ambiguous to a reader. It gets worse across a run of
similar declarations, where only the lines that happen to overflow would grow an extra line, for a
reason invisible on the page.

**An `@tag` buried mid-sentence in a JSDoc comment gets hoisted onto its own line.** JSDoc's own
spec expects a block tag to be followed by a line break; a tag embedded in running prose was never
really functioning as a tag to begin with, as far as any JSDoc tooling is concerned. An `@` inside
an email address, or inside backticks (`` `@ts-expect-error` `` naming a directive rather than
invoking one), is left alone.

</details>

## How this compares

Most formatters either don't touch comment prose at all, or treat it as an afterthought:

| Tool                                                                                          | Reflows comment prose?                                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`eslint-plugin-comment-length`](https://github.com/lasselupe33/eslint-plugin-comment-length) | Same goal, as an ESLint rule. JS/TS only. The closest prior art here.                                     |
| Prettier                                                                                      | Repositions and re-indents comments, never reflows their text. By design.                                 |
| Biome                                                                                         | Same stance as Prettier, on purpose.                                                                      |
| gofmt                                                                                         | Leaves comment text untouched entirely.                                                                   |
| rustfmt                                                                                       | `wrap_comments` exists, but defaults off and sits behind the nightly-only feature gate.                   |
| clang-format                                                                                  | The exception: `ReflowComments` defaults to `Always` in the base LLVM style. C/C++ only, no overlap here. |

`comment-fmt` covers JS/TS/JSX/TSX, CSS/SCSS, HTML, and Astro in one tool, instead of leaving comment
width to whichever per-language formatter happens to run.

## Escape hatches

Three forms, checked before anything else:

| Form           | Syntax                                                   | Effect                        |
| -------------- | -------------------------------------------------------- | ----------------------------- |
| Preceding line | `// comment-fmt-ignore` on its own line before a comment | The next comment is untouched |
| Inline         | `comment-fmt-ignore` anywhere inside a comment's body    | That comment is untouched     |
| File           | `comment-fmt-ignore-file` within the first 5 lines       | The whole file is skipped     |

Per language: `// comment-fmt-ignore` (JS), `/* comment-fmt-ignore */` (JS/CSS/JSX/TSX),
`<!-- comment-fmt-ignore -->` (HTML/Astro). An optional reason may follow after `--` or `: `, and
`comment-fmt` ignores it.

`extraDirectives` in `comment-fmt.json` (below) adds repo-specific directive prefixes to the
built-in protected list without needing this escape hatch at all.

## Usage

```ts
import {format} from 'comment-fmt';

format(source, {lang: 'js'}); // 'js' | 'css' | 'html' | 'astro', defaults to 'js'
// reflows over-width // and /* */ comments; everything else is untouched
```

...and via the CLI. With no file arguments it discovers every tracked file through `git ls-files`,
not a directory walk — a trailing `.` is treated as one explicit, literal file path that matches
nothing and silently no-ops, so don't pass one:

```bash
comment-fmt --check   # print a diff of what's wrong and exit 1 if anything would change
comment-fmt --write   # rewrite over-width comments in place
comment-fmt --diff    # same output as --check, minus the "run --write to fix" tip
```

Both `--check` and `--diff` print a standard `diff -U3`-style unified diff, windowed to a few
lines of context around each change with a `@@ -line,count +line,count @@` header, so a CI failure
is readable straight from the log without re-running anything locally.

Or pass explicit files, the pre-commit hook path, where the staged-file runner already narrowed the
list down and no discovery is needed:

```bash
comment-fmt --write src/foo.ts src/bar.css
```

`comment-fmt --report-overwidth [files...]` is a separate manual-review tool. It prints every
over-width comment that `format()` actually changed, grouped by shape (pipe-delimited, box-drawing,
aligned-space, tag-line, prose), so a human can sample the output and judge whether the heuristics
above are missing anything. It's not a pass/fail check, and it isn't part of the normal
`--check`/`--write` workflow.

## Configuration

An optional `comment-fmt.json` in the repo root. Most repos don't need one:

| Key               | Default | Notes                                                                                                                                        |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxLength`       | `110`   | Hard cap. No output line ever exceeds it.                                                                                                    |
| `targetLength`    | `105`   | Soft wrap target, always `<= maxLength`.                                                                                                     |
| `ignore`          | `[]`    | Glob patterns. Applies to a file whether it was discovered or named explicitly, so a hook that feeds every staged path still respects these. |
| `extraDirectives` | `[]`    | Extra prefixes appended to the built-in protected-directive list.                                                                            |

Everything else is hardcoded on purpose: no wrap-strategy option, no per-file overrides, no
`ignoreUrls` toggle, no `tabSize`.

A common use for `ignore` is excluding generated files and test fixtures, content nothing should
reformat, `comment-fmt` included:

```json
{
  "ignore": ["**/routeTree.gen.ts", "test/fixtures/**"]
}
```

## Pre-commit hooks

`comment-fmt --write` rewrites files as part of the hook, which puts real weight on getting
re-staging right. Run it **last**, after your language formatter. Prettier, Biome, oxfmt, whatever
you use, re-indents comments as part of formatting the surrounding code, and this tool's width math
depends on that final indentation. Run it first, and the formatter's own re-indent can push a line
back over the limit right after you fixed it, producing a diff on the very next commit for no
reason.

<details open>
<summary><a href="https://github.com/okonet/lint-staged"><code>lint-staged</code></a> (most projects)</summary>

```jsonc
// package.json
{
  "lint-staged": {
    "*.{ts,tsx,js,jsx,css,scss,html}": [
      "your-formatter --write",
      "comment-fmt --write" // last, after the formatter
    ]
  }
}
```

`lint-staged` needs something to actually invoke it on commit. If nothing does yet,
[`simple-git-hooks`](https://github.com/toplenboren/simple-git-hooks) is a lightweight installer for
that:

```jsonc
{
  "simple-git-hooks": {"pre-commit": "npx lint-staged"},
  "scripts": {"prepare": "simple-git-hooks"}
}
```

</details>

<details>
<summary><a href="https://viteplus.dev">Vite+</a> projects</summary>

Vite+'s own `staged` config is built on `lint-staged` and works the same way, one array, comment-fmt
last:

```ts
// vite.config.ts
export default defineConfig({
  staged: {
    '*': ['vp check --fix', 'comment-fmt --write']
  }
});
```

</details>

<details>
<summary><a href="https://github.com/evilmartians/lefthook">lefthook</a></summary>

`stage_fixed: true` is required. It's off by default, and without it a rewrite never reaches the
commit:

```yml
pre-commit:
  commands:
    comment-fmt:
      glob: '*.{ts,tsx,js,jsx,css,scss,html}'
      run: your-formatter --write {staged_files} && comment-fmt --write {staged_files}
      stage_fixed: true
```

</details>

In a monorepo, wiring this once at the workspace root is usually enough. File discovery runs from
wherever the hook runs, so a single root-level config already reaches every package without
per-workspace setup.

In CI, `comment-fmt --check` is independent of your formatter's own check. There's no ordering
constraint the way there is for the write-side hook, since `--check` never rewrites:

```bash
your-formatter --check . && comment-fmt --check .
```

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

## License

[MIT](LICENSE)
