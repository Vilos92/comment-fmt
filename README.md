# comment-fmt

A CLI that reformats comments in JavaScript/TypeScript, CSS/SCSS, HTML, and Astro: wraps overflowing
lines to a fixed width and normalises multi-line block comment shape. Meant to run from a pre-commit
hook, alongside your existing formatter.

```bash
bun add -D comment-fmt   # or: npm install --save-dev comment-fmt
```

## Why

A careful human writing a comment by hand tends to self-balance it reasonably well as they type --
their eyes are tracking the column position. An agent generating the same comment often doesn't: it
happily emits a line that blows past the configured print width, or wraps unevenly, because nothing
in its generation loop is tracking column position the way a human's eyes are. As more of a
codebase's comment volume comes from agents, "just eyeball it" stops being a plan.

This isn't only for agent-authored code, though. A human mid-review who just wants a deterministic
way to hold the line on a width limit benefits too, independent of who wrote the comment.

What made this worth building rather than a quick script: making comment reflow a _deterministically
correct_ operation -- never corrupting code, never mangling a hand-aligned table or ASCII diagram,
converging instead of oscillating from run to run -- is a real engineering problem, not a
solved-by-construction given. See [Overflow-only, by design](#overflow-only-by-design) below for how
that's enforced.

### Comparison

Most formatters either don't touch comment prose at all, or only handle it as an afterthought:

| Tool                                                                                          | Reflows comment prose?                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`eslint-plugin-comment-length`](https://github.com/lasselupe33/eslint-plugin-comment-length) | Yes -- an ESLint rule with the same goal, JS/TS only. The closest prior art for this project.                                                                                                          |
| Prettier                                                                                      | No. By design: Prettier repositions/re-indents comments but explicitly never reflows their text.                                                                                                       |
| gofmt                                                                                         | No. Comment text is left untouched; only surrounding whitespace/positioning is normalised.                                                                                                             |
| rustfmt                                                                                       | Off by default (`wrap_comments = false`); when enabled it wraps comment prose, but the option ships behind rustfmt's unstable/nightly feature gate.                                                    |
| clang-format                                                                                  | The outlier here: `ReflowComments` defaults to `Always` in the base LLVM style, so it already reflows comment prose to the column limit by default. C/C++ scope, so it doesn't overlap with this tool. |
| Biome                                                                                         | No, by design -- deliberately mirrors Prettier's stance here.                                                                                                                                          |

`comment-fmt` fills that gap across JS/TS/JSX/TSX, CSS/SCSS, HTML, and Astro in one tool, with the
width and shape rules described below, instead of leaving it to whichever per-language formatter you
already run.

## What it does

1. **Width** -- no comment line exceeds `maxLength` columns (110 by default), with reflow.
2. **Block shape** -- multi-line block comments never carry content on their opening (`/**`, `/*`,
   `<!--`) or closing (`*/`, `-->`) line. A comment that fits on one line collapses to it; a comment
   that doesn't expands to a starred (JS/CSS) or plain-indented (HTML/Astro) multi-line block. This is
   a one-way ratchet driven only by overflow: a multi-line comment that already fits is never
   collapsed back down, no matter how short its content is.

Everything else about a comment -- its wording, its structure, tables, ASCII diagrams, directive
comments (`eslint-disable`, `@ts-expect-error`, `prettier-ignore`, and friends) -- is left alone.

### Overflow-only, by design

The tool never even looks at a comment that already fits within `maxLength`. That single gate is what
protects hand-formatted structure: nearly every ASCII table, aligned column block, box diagram, and
deliberate line break in a real codebase already sits under the width limit, so the tool never has to
recognize them, and cannot mangle them. Heuristic detection of tables/diagrams is the second line of
defense for the rare over-width case, not the first -- a heuristic that has to correctly classify
every structure a human might invent will eventually fail, whereas "if it already fits, don't touch
it" cannot.

## Escape hatches

Three forms, checked before anything else:

| Form           | Syntax                                                   | Effect                        |
| -------------- | -------------------------------------------------------- | ----------------------------- |
| Preceding line | `// comment-fmt-ignore` on its own line before a comment | The next comment is untouched |
| Inline         | `comment-fmt-ignore` anywhere inside a comment's body    | That comment is untouched     |
| File           | `comment-fmt-ignore-file` within the first 5 lines       | The whole file is skipped     |

Per language: `// comment-fmt-ignore` (JS), `/* comment-fmt-ignore */` (JS/CSS/JSX/TSX),
`<!-- comment-fmt-ignore -->` (HTML/Astro). An optional reason may follow after `--` or `: `, and is
ignored by the tool.

`extraDirectives` in `comment-fmt.json` (below) can add repo-specific directive prefixes to the
built-in protected list (`eslint-disable`, `@ts-expect-error`, `prettier-ignore`, `biome-ignore`,
`webpackChunkName`, and similar tool directives) without needing this escape hatch at all.

## Usage

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

Or pass explicit files (the pre-commit hook path -- the staged-file runner already filtered to staged
files, so no discovery happens):

```bash
comment-fmt --write src/foo.ts src/bar.css
```

`comment-fmt --report-overwidth [files...]` is a separate, manual-review tool: it prints every
over-width comment `format()` actually changed, grouped by shape (pipe-delimited, box-drawing,
aligned-space, tag-line, prose), so a human can sample the output and judge whether the heuristics
above are missing anything -- not a pass/fail check, and not part of the normal `--check`/`--write`
workflow.

## Configuration

An optional `comment-fmt.json` in the repo root; most repos need no file at all:

| Key               | Default | Notes                                                                                                    |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `maxLength`       | `110`   | Hard cap. No output line may ever exceed it.                                                             |
| `targetLength`    | `105`   | Soft wrap target; always `<= maxLength`.                                                                 |
| `ignore`          | `[]`    | Glob patterns, filters file _discovery_ only -- an explicitly named file is always processed regardless. |
| `extraDirectives` | `[]`    | Appended to the built-in protected-directive list.                                                       |

Everything else is intentionally hardcoded: no wrap-strategy option, no per-file overrides, no
`ignoreUrls` toggle (URLs are always left unbroken), no `tabSize` (assumes 2).

## Pre-commit hook wiring

`comment-fmt --write` rewrites files during the hook, which puts real weight on re-staging and
partial-staging behavior. Run it as the **last** step in your staged-file runner, after your language
formatter (Prettier/Biome/oxfmt/etc.), not before: formatters commonly re-indent comments as part of
formatting the code around them, and this tool's width math depends on a comment's _final_
indentation. Running it first risks wrapping to a width that the formatter's own reindent then pushes
back over the limit, producing a spurious diff on the very next commit.

With [`lint-staged`](https://github.com/okonet/lint-staged):

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

With [`lefthook`](https://github.com/evilmartians/lefthook), `stage_fixed: true` is required --
without it, a rewrite never reaches the commit:

```yml
pre-commit:
  commands:
    comment-fmt:
      glob: '*.{ts,tsx,js,jsx,css,scss,html}'
      run: your-formatter --write {staged_files} && comment-fmt --write {staged_files}
      stage_fixed: true
```

In CI, `comment-fmt --check` is an independent validation from your formatter's own check --
there's no ordering constraint the way there is for the `--write` hook step, since `--check` never
rewrites:

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
