# Implementation Plan v3: `comment-fmt`

**Handoff document for a coding agent.** Supersedes v1 and v2. Read fully before writing code.

Changes from v2: repo scaffolded with Vite+ (§3), the tool dogfoods itself as consumer zero (§11), file
discovery drops `fs.glob` (§10), and the testing section is rewritten from a fixed checklist into a
strategy with case generation as an explicit, budgeted task (§9).

---

## Status

Kept up to date as phases land. The rest of this document is the frozen v3 plan itself and doesn't
change to reflect progress -- this section is the only part that does.

| Phase                    | State                                                                             | Where                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1 -- Scaffold            | done                                                                              | [PR #1](https://github.com/Vilos92/comment-fmt/pull/1)                                                         |
| 2 -- Core + JS lexer     | done                                                                              | [PR #2](https://github.com/Vilos92/comment-fmt/pull/2)                                                         |
| 3 -- CLI                 | done                                                                              | [PR #3](https://github.com/Vilos92/comment-fmt/pull/3)                                                         |
| 4 -- Differential corpus | done                                                                              | [PR #4](https://github.com/Vilos92/comment-fmt/pull/4)                                                         |
| 5 -- Block reshape       | done                                                                              | [PR #5](https://github.com/Vilos92/comment-fmt/pull/5)                                                         |
| 6 -- CSS + HTML lexers   | done (CSS in PR #6, HTML in PR #8)                                                | [PR #6](https://github.com/Vilos92/comment-fmt/pull/6), [PR #8](https://github.com/Vilos92/comment-fmt/pull/8) |
| 7 -- Rollout and tuning  | proof-of-concept pass in progress -- `vilos92.com` done, `greglinscheid.com` next | see status notes below                                                                                         |
| 8 -- Astro               | done, moved up ahead of `greglinscheid.com`'s rollout pass (was unscheduled)      | [PR #8](https://github.com/Vilos92/comment-fmt/pull/8)                                                         |

**PR #2** finished §12 Phase 2's scope: `core/{constants,measure,predicates,blocks,wrap}.ts` and
`lang/js.ts`, plus `src/index.ts`'s `format()` wired to the real engine in place of the Phase 1
placeholder. All four §9.1 invariants are verified via fast-check, run manually through `bun` rather
than `vp test` (see README's "Known issues" -- that's an upstream blocker, not a gap in that PR).

**PR #3** finished §12 Phase 3's scope: `src/cli/index.ts` (`--check`/`--write`/`--diff`, file
discovery per §10, the `comment-fmt.json` config surface) and this repo's own pre-commit hook
wiring (§11, "consumer zero"). It also closed a gap left over from Phase 2: the `comment-fmt-ignore`
escape hatch (§8.4) only had its self-protecting half implemented until that PR; `format()` now
honors the file-level, preceding-line, and inline forms for real. Deliberately does **not** bump the
version or publish to npm: that's deferred until closer to an actual public release, so
`package.json` stays at `0.0.0` through this phase and the ones after it.

**PR #4** finished §12 Phase 4's scope: `test/corpus/run.ts` (a differential-testing harness
checking the §9.1.4 code-invariance property over real code, not synthetic fixtures), a
`--report-overwidth` CLI mode for the §9.3/§8.3 structure-taxonomy sampling pass, and
`test/corpus/fetch.sh`, the single source of truth for the 15-repo corpus list. This deliberately
overrides §9.3's original text ("wire this as a scheduled CI job"): both a weekly cron and a
manual-trigger-only GitHub Actions workflow were tried and explicitly rejected during review, in
favor of no CI integration at all -- this is a purely local dev tool (`./test/corpus/fetch.sh &&
bun test/corpus/run.ts corpus/* node_modules`), run by hand whenever a change actually warrants
it. Also a documented scope reduction from the plan's suggested 20-30 repos. Run manually against
those 15 repos plus the five consumer repos and their `node_modules` (589,350 files total): zero
code-invariance violations, both then and after every subsequent phase's own re-run of the same
scan. A CodeRabbit review pass also caught a real positional-matching flaw in `--report-overwidth`
(a wrapped `//` comment legitimately becomes multiple comments once re-lexed, since each physical
line starts its own `//`) that's fixed as of that PR's final commit.

**PR #5 finishes** §12 Phase 5's scope, revised partway through review from the plan's
original two-threshold hysteresis design to something simpler and deliberately less aggressive.
Block shape (§1) is a one-way ratchet, symmetric with how width already works: a single-line
comment expands to the multi-line starred form when it overflows (the part of §1 that was only
partly implemented before this PR -- a comment expanding from single-line still put its first
content word directly on the `/**`/`/*` line), but a multi-line comment that already fits is never
collapsed back down, no matter how short its content is. `core/reshape.ts` and its hysteresis
machinery were deleted entirely rather than kept as a configuration option; the whole reason that
machinery existed was to decide _whether_ to collapse, and once collapsing left the picture there
was no decision left to make.

This reverses an initial implementation of §1's "comments that fit on one line collapse" language,
which turned out to have real user-facing costs the plan hadn't anticipated: it silently flattened
this repo's own multi-line section-comment convention the moment it landed (fixed at the time with
a `comment-fmt-ignore` annotation on every marker, since reverted along with the behavior that
required it), and more generally treats a human's or an agent's deliberate choice to write
something on multiple lines as a mistake to correct rather than an intentional decision to respect.
Checked against the tooling ecosystem before reverting: this project's own explicitly-cited
inspiration, `eslint-plugin-comment-length`, defaults to an `"overflow-only"` mode that never
collapses a fitting multi-line comment, with an opt-in `"compact"` mode for the old behavior; ESLint
core's own `multiline-comment-style` rule never does width-based collapsing at all. The tool's job
is rescuing overflow, not having opinions about a comment being more compact than it needs to be.

The 589,350-file corpus re-run this phase (repeated again after the mid-review revision) surfaced
one real, previously-unreachable bug, fixed with a regression fixture: a continuation prefix
without a trailing space (some files use `' *'`, not `' * '`) concatenated directly against content
starting with `/` (an embedded `// example` line inside a larger comment's prose) formed a literal
`*/` and prematurely closed the comment, corrupting the file. That same corpus run also surfaced a
separate, unrelated bug worth fixing alongside it: this repo's own pre-commit hook was silently
rewriting staged `test/fixtures/**` files, since `comment-fmt --write`, unlike `vp check --fix`, has
no built-in exclusion for explicitly-named files (`ignore` only filters discovery, per §6) and
lint-staged feeds every staged path explicitly. Fixed with `scripts/staged-write.sh`, a thin wrapper
that filters fixture paths out before invoking the real CLI. A first version of that wrapper matched
against `test/fixtures/*`, which silently matched nothing at all: `lint-staged` passes every staged
path as absolute by default, so the pattern needed a leading `*/` to match regardless of prefix
length. Caught by a review pass, then confirmed live with a genuinely overflowing fixture staged
through the real hook. 83 fixture pairs live under `test/fixtures/js/` as of this PR.

Also landed on `test/corpus/run.ts` this phase: a `MAX_FILE_BYTES` skip (2MB) for the rare
pathological giant file (a synthetic 583,000-line TypeScript stress-test fixture, a 12.6MB minified
bundle vendored into `node_modules`) whose per-comment reflow cost otherwise dominated total scan
time without surfacing anything beyond raw scale, every skip reported by path and size rather than
silently shrinking coverage. The new size check's own `statSync` call is wrapped in the same
try/catch-and-record pattern as the adjacent `readdirSync`, so a broken symlink or a TOCTOU race
during a long scan fails that one file, not the run.

**PR #6 (this one) is the CSS half** of §12 Phase 6's scope: `lang/css.ts` (`/* */` and SCSS `//`,
skipping strings and `url(...)` contents -- including the specific `url(data:...base64,...)`
adversarial case where a base64 payload can contain a stray `//`). The reflow logic in
`src/index.ts`, the escape hatch, and directive protection needed zero changes to work correctly for
CSS, confirmed directly: this is the payoff of §4's "every lexer returns the same `Comment` shape, so
`core/` never learns what language it's in" design constraint. `format()` gained an `options.lang:
'js' | 'css'` dispatch (default `'js'`, so every existing caller keeps working unchanged), and
`src/cli/index.ts`/`test/corpus/run.ts` both learned to route `.css`/`.scss` files to it. The
589,350+ file corpus re-run (now genuinely exercising CSS/SCSS for the first time, not just JS/TS)
found zero code-invariance violations, both before and after a self-review pass that extracted
scanning logic duplicated between `js.ts` and `css.ts` into a shared `lang/shared.ts` module. 15
fixture pairs live under `test/fixtures/css/`, covering plan §14.9's adversarial case list.

A later review round found the `url(...)` adversarial case only covered the literal spelling: CSS
also permits `url` written with identifier escapes (`u\72l(...)` is spec-legal, decoding to the same
`url`), and `checkIsUnquotedUrlStart`'s plain 3-character match missed it entirely, letting a `//` in
an escaped-spelling `url(...)`'s payload get misdetected as an SCSS comment (confirmed: a base64
payload's bytes got a stray space spliced in on reflow). Fixed with a bounded backward scan that
falls back to decoding CSS identifier escapes only when the literal match fails, so the common case
stays a cheap slice comparison. The `accident-url-slash-slash-not-comment` fixture now covers both
spellings.

**HTML is deliberately not in this PR.** It's a materially different problem from CSS: it needs to
delegate `<script>`/`<style>` region contents to the JS/CSS lexers with position-offsetting (not a
simple call-through, since a nested lexer's offsets are relative to the substring it was given, not
the whole document), it carries a _stricter_ invariant than JS/CSS/SCSS (an HTML comment can never
contain `--` _anywhere_ in its body, not just at the closing boundary, per the HTML spec -- §14.10's
adversarial case list names this explicitly), and it has raw-text elements (`<textarea>`, `<pre>`)
that don't parse as markup at all. This is exactly the kind of design surface worth resolving with
the user's input before implementation, not deciding unilaterally partway through a phase.

**Phase 7 is starting as a proof-of-concept pass, not the full rollout §11 describes.** §11's original
text wires the real `lint-staged` hook and a published `"comment-fmt": "^0.1.0"` npm dependency into each
target repo as it goes. That's premature: nothing has been proven against real external repos yet, and
publishing before that proof is backwards. So this pass, per repo (smallest blast radius first --
`vilos92.com` first), is: run `--write`, self-review the diff for mangles the way §11's grep list
describes, then open a PR in that repo containing **only** the reformat diff -- no `package.json` change,
no hook wiring, no CI change -- clearly marked as a temporary/exploratory PR, not one meant to merge as-is.
Any real mangle found becomes a new fixture here, in this repo, matching §11's existing rule. Once all
five repos have gone through this and the results hold up, those proof PRs likely get closed rather than
merged, and the actual sequencing becomes: clean up and publish `comment-fmt` as a real npm package first
(§11's own "once operational" README step below, plus `AGENTS.md`'s "delete this file, sweep `plan §N`
citations" instruction), _then_ wire the real hook into each repo as a proper dependency, per §11's
original hook-wiring guidance.

**Phase 8 (Astro) moved up ahead of `greglinscheid.com`'s rollout pass, superseding §12's original
phasing below,** and both it and Phase 6's outstanding HTML half landed together in this same PR (after
`vilos92.com`'s POC pass, per the reorder's own reasoning: `greglinscheid.com` is Astro-based and second
in blast-radius order, so running its POC with no `astro.ts` lexer would've surfaced nothing at all, not
"not common enough to bother with" -- `.astro` wasn't in `LANG_BY_EXTENSION` anywhere).

`lang/html.ts` locates `<!-- -->` comments, skips quoted attribute values (so
`<a href="<!-- oops">Link</a>` doesn't corrupt everything up to the next real `-->`), never reports one
inside `<textarea>`/`<title>` (RCDATA elements per the WHATWG spec -- distinct from `<script>`/`<style>`'s
own raw-text category, but the same practical consequence: never real comment nodes) or `<pre>` (a real
comment, but never reflowed -- not because its whitespace is rendering-significant, a comment is never
rendered at all, but to preserve `<pre>`'s own strong "keep this exactly as authored" signal, the same
conservative bias this project already applies elsewhere), and delegates `<script>`/`<style>` bodies to
`js.ts`/`css.ts` with offsets remapped back onto the real document, mirroring the `<script>`/`<style>` note
in §4. Both WHATWG-defined degenerate short forms (`<!-->`, `<!--->`) are handled explicitly
-- getting either wrong would search onward for the _next_ real `-->` and swallow everything up to it as
one comment, a genuine corruption bug caught by construction, not by testing after the fact. `src/index.ts`
gained a per-language `FreshBlockStyle` (JS/CSS keep the JSDoc `* ` convention when a comment expands from
single-line; HTML has none, so it gets plain indentation with the closer flush at the opener's own column)
and `Comment` gained an optional `lang` field so a comment delegated from `<script>`/`<style>` keeps its
own language's style even inside an `html`-mode `format()` call -- confirmed as a needed fix, not
theoretical: an early version lost `<style>`'s `* ` convention entirely because `reflowBlockComment` only
ever consulted the top-level `format()` call's own `lang`.

`lang/astro.ts` splits a file at its `---` frontmatter fence (files may have none at all), delegating the
frontmatter to `js.ts` and the template to `html.ts`, both using the same offset-remapping approach. A
known, disclosed gap: a bare `{expression}` slot in the template -- including the common
`{/* comment */}` convention for a template-only comment -- isn't treated as a nested-JS region. Attempting
it (per this file's own "find out by attempting it" framing) surfaced that an attribute value can _be_ a
bare `{expr}` with no quotes at all, so finding its true end needs real brace-depth tracking that skips
strings and nested template literals correctly, not a shallow brace count -- a real undertaking of its own,
better justified by real signal than guessed at. Checked against `greglinscheid.com` itself (18 real
`.astro` files): zero contain `{/* */}` at all, and zero would change under `--check` regardless (every
comment already fits) -- so the gap costs nothing today, and building it speculatively wouldn't have been.

16 HTML fixture pairs and 6 Astro fixture pairs live under `test/fixtures/{html,astro}/`, covering §14.10's
adversarial case list plus the delegation/frontmatter/known-gap cases above. The differential corpus scan
(106,751 files: the 15-repo corpus plus `node_modules`, now genuinely exercising HTML for the first time)
found zero code-invariance violations, and a separate read-only pass directly against `greglinscheid.com`
(16,346 files including its real `.astro` content) found zero as well.

**Once Phase 7 lands, delete this file** -- and before deleting it, sweep every `(plan §N)` citation out
of the codebase's comments first. It's a handoff document for building the tool, not permanent project
documentation, and every comment that cites it (13+ across `src/`, `test/`, and `AGENTS.md` as of this
PR) is a dangling reference the moment it's gone. A comment should explain _why_ the code works the way
it does -- that's true forever, regardless of which phase built it. A comment that instead explains what
the plan said to do is only true _while the plan still exists to say it_, and reads as unfinished once
the roadmap it's pointing at is done and removed. Rewrite each citation into the rationale it was
standing in for; if a comment turns out to have no real "why" without the citation, that's worth
noticing too, not papering over.

---

## 1. What we are building

A single npm-published CLI that reformats comments across JavaScript/TypeScript, CSS/SCSS, and HTML,
invoked from a pre-commit hook.

1. **Width** — no comment line exceeds 110 columns, with reflow.
2. **Block shape** — multi-line block comments have no text on the opening (`/**`, `/*`, `<!--`) or
   closing (`*/`, `-->`) line; comments that fit on one line collapse, comments that don't expand to a
   starred block.

Motivation: much of the comment volume in these repos is agent-written, and agents don't know the
configured print width. This converts a repeated manual fix into a deterministic one.

### Consumer repos

| Repo                      | Toolchain | Integration         |
| ------------------------- | --------- | ------------------- |
| `comment-fmt` (this tool) | Vite+     | **dogfoods itself** |
| `scriptlancer` (monorepo) | Vite+     | pre-commit          |
| `greglinscheid.com`       | Vite+     | pre-commit          |
| `vilos92.com`             | Vite+     | pre-commit          |
| `gdex`                    | Biome     | pre-commit          |
| `grynthia.cat`            | Biome     | pre-commit          |

All share one house style: single quotes, semicolons, no trailing commas, arrow parens omitted, no
bracket spacing, **110-column print width**. (Biome's `arrowParentheses: "asNeeded"` and oxfmt's
`arrowParens: "avoid"` are the same setting under two names.)

**Not yet covered: `.astro` files.** `greglinscheid.com` is Astro-based, so its `.astro` files (frontmatter
between `---` fences, HTML-like template markup, both can hold comments) sit outside JS/TS/JSX/TSX +
CSS/SCSS + HTML as scoped above. Worth adding later, not scoped into any phase yet -- see §4's
architecture note and §12's unscheduled Phase 8.

---

## 2. Locked decisions

| Decision                | Choice                              | Why                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrapping strategy       | `pretty` only, **not configurable** | Opinionated by design. No strategy dispatch, no config plumbing.                                                                                                                                                              |
| Language coverage       | JS/TS/JSX/TSX + CSS/SCSS + HTML     | Comments are lexical, so multi-language is nearly free — and no existing tool does all three.                                                                                                                                 |
| Integration             | Pre-commit hook                     | Biome cannot invoke external tools (GritQL only; nothing on the 2026 roadmap). Neither can oxfmt. The hook layer is the only thing that works uniformly across all repos.                                                     |
| Editor integration      | Out of scope                        | Fix-on-commit, not fix-on-save. No LSP.                                                                                                                                                                                       |
| Distribution            | npm                                 | Multi-machine.                                                                                                                                                                                                                |
| Implementation language | **TypeScript**                      | Measured: 500 files / 4,429 comments rewritten in 93 ms on Node 22. Startup cost is noise inside a hook that already runs lint and format. Rust reintroduces platform packages and a release matrix for no user-visible gain. |
| Repo toolchain          | **Vite+**                           | §3                                                                                                                                                                                                                            |

### Explicitly not building

No `wrapStyle` option, no Knuth–Plass `balance`, no ESLint/Oxlint rule adapter, no LSP, no stylelint or
Biome plugin.

---

## 3. Repo setup

Scaffold with `vp create`. Vite+ covers the whole toolchain and keeps this repo consistent with the
three vp consumers:

| Need          | Command            |
| ------------- | ------------------ |
| Test          | `vp test` (Vitest) |
| Lint          | `vp lint` (Oxlint) |
| Format        | `vp fmt` (Oxfmt)   |
| Build the CLI | `vp pack` (tsdown) |

`vp pack` is built on tsdown and handles library **and** CLI builds — `dts`, ESM output, `bin` entries,
and shebangs. Config lives inline in `vite.config.ts`:

```ts
import {defineConfig} from 'vite-plus';

export default defineConfig({
  pack: {dts: true, format: ['esm'], sourcemap: true},
  fmt: {
    printWidth: 110,
    semi: true,
    singleQuote: true,
    trailingComma: 'none',
    arrowParens: 'avoid',
    bracketSpacing: false
  },
  lint: {rules: {curly: ['error', 'all'], 'no-nested-ternary': 'error'}}
});
```

Match the house style exactly — this repo should be indistinguishable from the other vp repos.

**Note for later:** tsdown also has an `exe: true` option that produces a standalone executable requiring
no installed Node. If the single-binary property ever matters, it's available from TypeScript without a
Rust rewrite. Not needed for v1.

---

## 4. Architecture

```
src/
  core/                      <-- pure, language-agnostic, zero I/O
    wrap.ts                    the pretty algorithm (§7)
    measure.ts                 display width (tabs; see §9)
    predicates.ts               isDirective, isUrl, isCodeLike, isTagLine, isTableLike
    blocks.ts                   split comment body into logical blocks
    reshape.ts                  single <-> multi-line block shape
    constants.ts                maxLength, targetLength, orphanMinRatio
  lang/                      <-- one lexer per language, all returning Comment[]
    types.ts                    { kind, open, close, linePrefix, start, end, indent, ownLine }
    js.ts                       // and /* */ ; skips strings, template literals, regex
    css.ts                       /* */ and SCSS // ; skips strings and url()
    html.ts                      <!-- --> ; skips attrs, delegates <script>/<style>
    astro.ts (later, unscheduled)  frontmatter delegates to js.ts, template delegates to html.ts
  cli/
    index.ts                    argv, --check / --write / --diff, exit codes
test/
  fixtures/{js,css,html}/       .input / .expected pairs
  props/                        fast-check invariant tests
  corpus/                       differential-testing harness (§9.3)
```

**Hard rules:**

- `core/` imports nothing from `lang/`, `cli/`, or `node:*`. Strings and options in, strings out.
- `lang/` locates comments and their prefixes. No reflow logic.
- `cli/` is the only layer touching the filesystem.
- Every lexer returns the same `Comment` shape, so `core/` never learns what language it's in. This is
  what makes CSS and HTML nearly free once JS works.

**On the JS lexer:** do not pull in a parser. You need to find comments while correctly skipping string
literals, template literals (including nested `${}`), and regex literals. The regex-vs-division ambiguity
is the classic trap — resolve it by tracking the previous significant token. **This is the highest-risk
component in the project**; see §9.

**On the (unscheduled) Astro lexer:** an `.astro` file is frontmatter (TS between `---` fences) followed
by HTML-like template markup that can itself hold `{expression}` slots. The natural design mirrors how
`html.ts` already delegates `<script>`/`<style>` to `js.ts`/`css.ts`: split the file at the fence
boundaries, delegate the frontmatter to `js.ts` unchanged, and delegate the template portion to `html.ts`
(which would then also need to treat a bare `{...}` expression slot as a nested-JS region, the same way it
already treats `<script>`). Whether that JS-in-template handling is cheap or turns into its own can of
worms is exactly the kind of thing to find out by actually attempting it, not by planning further here.

---

## 5. Required reading

Clone both. Read the ★ files before writing code. Since we're also in TypeScript, most of the first repo
is directly liftable — port, don't reinvent.

### `github.com/lasselupe33/eslint-plugin-comment-length` (MIT)

Whole `rules/src` tree is ~1,700 LOC.

**★ Edge-case utilities — the actual asset. All tiny; read every one.**

| Path                                              | LOC | Why                                                                                                         |
| ------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------- |
| `rules/src/utils/is-semantic-comment.ts`          | 21  | Directive skip list. Incomplete for our stack — §8.1.                                                       |
| `rules/src/utils/is-line-overflowing.ts`          | 12  | Overflow predicate. Note `line.trim().split(" ").length > 1`: an unbreakable single token is never flagged. |
| `rules/src/utils/is-url.ts`                       | 13  | URL regex, lifted from ESLint's `max-len`.                                                                  |
| `rules/src/utils/is-code-in-comment.ts`           | 31  | Instantiates a `Linter` per comment. **Do not port** — §8.2.                                                |
| `rules/src/utils/is-jsdoc-like.ts`                | 3   | How `@param` lines are protected.                                                                           |
| `rules/src/utils/is-comment-in-comment.ts`        | 3   | Nested comment markers.                                                                                     |
| `rules/src/utils/is-on-own-line.ts`               | 14  | Trailing-comment detection. We do this without an AST — read for the concept.                               |
| `rules/src/utils/is-another-wrap-point-coming.ts` | 18  | Punctuation-aware wrap points.                                                                              |
| `rules/src/utils/is-punctuation.ts`               | 5   | ditto                                                                                                       |

**★ Reflow engine**

- `limit-multi-line-comments/root.ts` (99) — block entry point
- `limit-multi-line-comments/util.capture-next-block.ts` (169) — largest file; logical-block detection,
  the subtle part
- `limit-multi-line-comments/util.format-block.ts` (74), `fix.overflow.ts` (56),
  `util.extract-blocks.ts` (36), `detect.overflow.ts` (28), `util.boilerplate-size.ts` (9)
- `limit-single-line-comments/root.ts` (127) plus `util.capture-nearby-comments.ts` (44),
  `util.capture-relevant-comments.ts` (45), `util.format-block.ts` (58), `fix.overflow.ts` (15)

(All paths relative to `rules/src/rules/`.)

**★ Options and fixtures**

- `rules/src/typings.options.ts` (116) — verified defaults
- `rules/src/utils/testing.get-code.ts` (60) — fixture loader; read first
- `rules/src/rules/limit-multi-line-comments/tests/` — **33 fixtures**
- `rules/src/rules/limit-single-line-comments/tests/` — **24 fixtures**

Port fixture _content_ as plain `.input` / `.expected` text pairs, not `.ts` modules, so the CSS and HTML
lexers reuse one harness.

### `github.com/gajus/eslint-plugin-jsdoc` (BSD-3-Clause)

Block shape only. `src/rules/multilineBlocks.js` (562), `test/rules/assertions/multilineBlocks.js`
(1,135), `docs/rules/multiline-blocks.md`. It depends on `@es-joy/jsdoccomment` — **do not take that
dependency**; read for edge cases, not architecture.

---

## 6. Config surface

One optional `comment-fmt.json`; most repos need no file.

| Key               | Default | Notes                          |
| ----------------- | ------- | ------------------------------ |
| `maxLength`       | `110`   | Matches print width everywhere |
| `targetLength`    | `105`   | Soft wrap target (§7)          |
| `ignore`          | `[]`    | Glob patterns                  |
| `extraDirectives` | `[]`    | Appended to the built-in list  |

Everything else is hardcoded: no `wrapStyle`, no `mode`, no `logicalWrap`, no `ignoreUrls` toggle (always
on), no `tabSize` (assume 2).

`orphanMinRatio` lives in `core/constants.ts` with a `COMMENT_FMT_ORPHAN_RATIO` env override that exists
**only** for the §11 tuning pass. Delete it after.

---

## 7. The wrapping algorithm (`pretty`)

Greedy fill, then a bounded orphan correction. Not Knuth–Plass.

```
0. OVERFLOW-ONLY GATE. If every line of the comment is already <= maxLength,
   return it byte-for-byte unchanged. Do not split into blocks, do not reflow,
   do not normalise whitespace. Exit immediately.
1. Split the comment body into logical blocks (blank line, list-item change,
   tag line, or fence boundary starts a new block).
2. Greedily fill only the blocks that contain an overflowing line.
   Blocks entirely within the limit are passed through untouched.
3. Orphan guard: while the final line's width < maxLength * orphanMinRatio,
   AND the preceding line has more than one word,
   AND moving its last word forward keeps every line <= maxLength:
       move that word down.
   Cap at 2 moves. Stop if no improvement.
4. No line may ever exceed maxLength. Hard invariant.
```

**Step 0 is not an optimisation — it is the primary safety property, and it is the single most important
line in this document.** Upstream calls this `mode: "overflow-only"` and defaults to it. We hardcode it,
and there is no `compact` mode to turn it off.

It is what protects hand-formatted structure. Nearly every ASCII table, aligned column block, box
diagram, and deliberate line break in a real codebase already sits under 110 columns — so the tool never
looks at them, never has to recognise them, and cannot mangle them. Heuristic detection (§8.3) is the
second line of defence for the rare over-width case, not the first. Never reverse that order: a heuristic
that must correctly classify every structure a human might invent will fail, whereas "if it fits, don't
touch it" cannot.

Two widths, deliberately: wrap to `targetLength` (105) while `maxLength` (110) is an inviolable cap. This
is Safari's approach for `text-wrap: pretty` — aim slightly narrow so the algorithm can undershoot and
overshoot against the target without breaking the real limit. You get the flexibility of an overflow
tolerance while "no line exceeds 110" stays literally true, so the tool never disagrees with the
formatter about what's legal.

**Why not `balance`:** global DP means one added word rewrites every line of a paragraph. For something
autofixing on commit that's noisy diffs and damaged `git blame`. Greedy-plus-orphan-guard is local — it
changes the minimum, which is what makes an autofixer trustworthy enough to leave on. Browsers made the
same call: `pretty` is for body text, `balance` is capped at six lines in Chrome and scoped to headings.

`orphanMinRatio` starts at `0.3` (≈33 chars at 110 columns). It is a tuning parameter, not a derived
constant — settle it empirically in §11, not by reasoning. A word-count threshold was the wrong unit ("a"
and "internationalization" are both one word); keep a floor of 2 words as a secondary guard for the
single-long-token case.

---

## 8. Deliberate improvements over upstream

### 8.1 The directive list is incomplete for this stack

Upstream skips `eslint-disable`, `eslint-enable`, `stylelint-disable`, `stylelint-enable`,
`tslint:disable`, `tslint:enable`. That predates our toolchain. **Missing and directly relevant:**

`biome-ignore` · `oxlint-disable`, `oxlint-disable-next-line` · `@ts-expect-error`, `@ts-ignore`,
`@ts-nocheck` · `prettier-ignore`, `oxfmt-ignore` · `v8 ignore`, `c8 ignore`, `istanbul ignore` ·
`#__PURE__`, `@__PURE__` · `webpackChunkName` and sibling magic comments · `@vite-ignore` ·
`stylelint-disable-next-line` in CSS · HTML conditional comments and SSI (`<!--#include`)

This is a **correctness** bug class and it fails silently: wrap a long
`oxlint-disable-next-line some-rule-name` and it stops disabling the rule while CI stays green. Implement
as an explicit exported list with a fixture per entry, not a chain of `||`.

### 8.2 Replace `ignoreCommentsWithCode`

Upstream constructs a fresh ESLint `Linter` and calls `.verify()` on every comment body. That's why they
default it off. We have no linter to borrow — use a heuristic instead, and detect fenced code as
**regions** rather than per-line (upstream does this poorly): a ` ` ``` fence or `@example` tag opens
a protected region until closed.

### 8.3 Protect tabular and aligned content

Not in upstream at all, and it's the original objection to this whole idea.

**There is no standard format for this, and do not design as if there were.** Structures that appear in
real comments include, at minimum: GFM tables with pipes; space-aligned columns with no pipes; ragged
space-aligned columns; ASCII boxes (`+---+`); Unicode box drawing (`┌─┐│└┘`); tree diagrams (`├──`,
`└──`, `|--`); flow diagrams with arrows (`-->`, `<-`); aligned `@param` descriptions; indented
(non-fenced) code blocks; section dividers (`// =====`); tab-aligned columns; and freeform ASCII art that
follows no pattern at all. Agents will not produce these consistently — different models and different
sessions pick different styles for the same content — and neither do OSS codebases.

So the detector is **best-effort by design**, and that is acceptable only because of the ordering in §7
step 0: it never sees a comment that already fits. Design it to **fail safe** — when uncertain, skip the
block. A false positive costs one unformatted comment; a false negative destroys a diagram.

**Two tiers.**

_Tier 1 — high precision, worth getting exactly right._ GFM tables. JSDoc is rendered as markdown by
VS Code hovers and by TypeDoc, so people genuinely write GFM in comments and it is the one shape with a
real specification. Detect via a delimiter row matching `/^[\s|:-]+$/` containing at least one `|`, with
a pipe-bearing line above it. That test is precise enough to trust.

_Tier 2 — heuristic, deliberately loose._ 2+ runs of consecutive spaces at consistent columns across 3+
lines; `|` at consistent columns; any box-drawing or tree character (`─│┌┐└┘├┤┬┴┼` and `+--`, `|--`); 3+
consecutive lines whose indentation exceeds the block's base indent by 2 or more.

**Do not try to complete this list by reasoning.** Complete it by measurement — see §9.3.

### 8.4 An escape hatch — `comment-fmt-ignore`

**Required, not optional.** Prettier declined to reflow comments precisely because it has no per-comment
opt-out and therefore no way to be wrong safely. If we ship without one, we have reproduced the exact
problem that made Prettier refuse — a fixer with no override is a fixer people disable entirely the first
time it mangles something they cared about.

#### Forms

Three, and deliberately no more:

| Form           | Syntax                                                   | Effect                        |
| -------------- | -------------------------------------------------------- | ----------------------------- |
| Preceding line | `// comment-fmt-ignore` on its own line before a comment | The next comment is untouched |
| Inline         | `comment-fmt-ignore` anywhere inside a comment's body    | That comment is untouched     |
| File           | `comment-fmt-ignore-file` within the first 5 lines       | The whole file is skipped     |

Per language: `// comment-fmt-ignore` (JS/SCSS), `/* comment-fmt-ignore */` (JS/CSS),
`<!-- comment-fmt-ignore -->` (HTML).

An optional reason may follow after `--` or `: `, and is ignored by the tool. Do **not** require one —
Biome requires a reason on `biome-ignore` because it's a team linter guarding shared rules; this is a
formatter with one user, and mandatory prose is friction that leads to people disabling the tool instead.

**No `-start` / `-end` range pair.** Comments are discrete units, so ranges add parser state and boundary
cases for no real benefit. Explicit non-goal.

#### Design constraints

**No leading `@`.** `@comment-fmt-ignore` inside a JSDoc block gets parsed as a JSDoc tag by TypeDoc,
jsdoc, and VS Code's hover renderer — it will render as an unknown tag, and some tag parsers choke on
unrecognised ones. Use a bare hyphenated token.

**Placement differs for JSDoc.** The inline form is fine in a plain `/* */` block, but a JSDoc body is
rendered as markdown in VS Code hovers and in TypeDoc output, so an inline directive becomes visible
tooling noise in the IDE. **Recommend the preceding-line form for JSDoc and the inline form for
everything else.** (A `<!-- comment-fmt-ignore -->` inside a JSDoc block would be hidden by markdown
renderers, which is cute but too obscure to document as the happy path. Support it if it falls out for
free; don't lead with it.)

**Self-protecting.** Add all three forms to the §8.1 directive list, so an ignore directive long enough
to wrap is never itself wrapped. Write the fixture.

#### Documenting it — put it in the output, not the README

The docs question is really a discoverability question, and README sections are not where people learn
escape hatches. They learn at the moment of friction.

- `--check` failure output ends with a one-line footer showing the ignore syntax. This is the
  highest-leverage placement in the whole project: the moment someone sees the tool wanting to change
  something they care about is the exact moment they need this.
- `--diff` output carries the same footer.
- `--verbose` reports the count of comments skipped due to ignores, so a repo silently accumulating forty
  of them becomes visible instead of drifting.
- README covers it in one section near the top, above configuration — not buried in an options table.

The rollout in §11 depends on this existing: every mangle found in a bulk-reformat diff becomes a new
fixture _and_ gets an ignore directive, so the commit can land while the underlying bug is fixed properly
rather than blocking on it.

---

## 9. Testing

**This is the core of the plan, not an appendix. Budget more time here than on the implementation.**

The list below is a **floor, not a ceiling.** Generating cases is an explicit task (§9.2), and the agent
is expected to produce far more than is written here — anyone reading the actual lexer will find
breakages nobody thought to enumerate in advance.

### 9.1 Layer one: the invariants

Four properties must hold for every input. Test with `fast-check` over thousands of generated bodies
(mixed word lengths, URLs, tags, fences, unicode, pathological whitespace):

1. **Idempotency** — `fmt(fmt(x)) === fmt(x)`. Non-convergence is a real failure mode, not a theoretical
   one.
2. **Content preservation** — the token multiset of comment bodies is identical in and out. No word
   lost, none duplicated.
3. **Width cap** — no output line exceeds `maxLength` unless it holds an unbreakable token or is
   table-like.
4. **★ Code invariance** — re-lex the output and assert the **non-comment token stream is byte-identical
   to the input's.** A correct comment formatter changes only comments, by definition. This is the
   strongest available guard against the lexer mistaking a string or regex for a comment and corrupting
   a file, and it's cheap to implement once the lexer exists. Make it the first property test written and
   run it over every corpus file in §9.3.

### 9.2 Layer two: adversarial case generation (an explicit task)

A dedicated pass whose only goal is producing inputs that break things. Run it **twice** — once before
the implementation is called done, once after — and once per language. Rough targets: 200+ cases for JS,
60+ each for CSS and HTML. Every case that breaks something becomes a permanent fixture.

Seed categories, to be expanded rather than treated as complete:

_JS lexer (highest risk)._ `"// not a comment"` · `` `${a /* c */ + b}` `` · `/regex\/with\/slashes/ //
real comment` · division vs regex after `)` and after an identifier · `<!--` in JS (legacy HTML comment
syntax) · unterminated block comment at EOF · comment inside JSX attribute vs JSX child · `//` inside a
URL inside a string · nested template literals three deep · regex containing `//` · comment immediately
after a `return` with ASI implications.

_Directives._ One case per entry in §8.1, at a length that would otherwise wrap, in every language that
supports it.

_Structure._ ASCII tables · aligned key-value columns · box drawing · markdown lists with hanging indents
· nested lists · fenced code · `@example` blocks containing comments · license banners · long `@param`
descriptions · tag lines mixed with prose.

_Width and encoding._ Exactly at limit, one under, one over · CJK · emoji including ZWJ sequences ·
combining characters · tabs mixed with spaces · CRLF · no trailing newline · BOM.

_Degenerate._ Empty comment · whitespace-only · a single word longer than `maxLength` · a comment that is
one 5,000-character token · 500 consecutive `//` lines · file that is nothing but a comment · zero-byte
file.

_CSS._ `url(data:...)` containing `/*` · string containing `*/` · SCSS `//` at end of a declaration ·
comment inside a media query.

_HTML._ `--` inside a comment body (must never produce invalid HTML) · comment inside `<pre>` · comment
inside `<script>` delegating to the JS lexer · comment inside an attribute value · conditional comments.

### 9.3 Layer three: differential testing against real code

**The highest-value technique here, and the one that finds what nobody would think to write.**

Build a corpus harness that runs `--check` over large volumes of real code and reports every file the
tool wants to modify:

- the five consumer repos
- `node_modules` in each of them (enormous, free, and stylistically diverse)
- 20–30 popular OSS repos cloned fresh — pick ones with heavy comment styles (TypeScript, Vue, Rollup,
  Vite, Biome, ESLint itself)

Two failure classes fall out automatically. **Files it changed that it shouldn't** are bugs — triage
every one. **Files it should have changed but didn't** are misses — sample them. Run property 9.1.4 over
every corpus file; a single code-invariance violation anywhere in `node_modules` is a lexer bug worth
stopping for.

Wire this as a scheduled CI job, not a per-commit one. It's slow and it's a net, not a gate.

**Build the structure taxonomy here, not by guessing.** Add a `--report-overwidth` mode that dumps every
comment which (a) exceeds `maxLength` and (b) the tool wants to modify, grouped by shape. Across this
corpus that set is small — the §7 step 0 gate excludes everything that already fits, which is the
overwhelming majority — and it is directly inspectable. Read it by hand and classify. That output _is_
the real list of over-width structures in the wild, and it should drive the Tier-2 patterns in §8.3
rather than the reverse. Any shape found there that the detector missed becomes both a new pattern and a
permanent fixture.

Expect this pass to change §8.3. If it doesn't, you probably didn't read the output.

### 9.4 Layer four: mutation testing

Once, near the end, run Stryker over `core/` and `lang/`. It answers the question the other layers can't:
_would this suite actually catch a bug?_ Surviving mutants point at untested branches. Not worth running
continuously.

### 9.5 Workflow

Snapshot-driven, so adding a case costs nothing: drop an `.input` file in `test/fixtures/<lang>/`, run
with `UPDATE_SNAPSHOTS=1`, eyeball the generated `.expected`, commit both. If adding a fixture is more
work than that, fix the harness first — friction here directly reduces how many cases get written.

Add a `--diff` mode early. It makes both the §9.3 triage and the §11 rollout reviewable instead of a wall
of changed files.

---

## 10. File discovery

No globbing library, and no `fs.glob` either — it's still experimental on Node 22 and prints a warning to
stderr on every invocation, which is visible noise inside a hook.

- **Files given as argv** → use them. This is the hook path; `lint-staged` passes staged files directly,
  so no discovery happens at all.
- **No argv** → `git ls-files` via `node:child_process`. Gitignore-respecting for free, zero dependencies,
  and correct by construction in a repo.
- **Not a git repo** → recursive `node:fs` walk with an extension filter, ~30 lines.

Combined with `node:util`'s `parseArgs` for flags, the tool ships with **zero runtime dependencies**.
Verified working on Node 22. Keep it that way — every dependency added is one the hook pays for on every
commit, and a fat import can take boot from 35 ms to 300 ms without anyone noticing the regression.

---

## 11. Rollout

**Consumer zero is this repo.** Wire `comment-fmt` into its own pre-commit hook as soon as Phase 2 lands,
and keep it there. The tool formatting its own source is the cheapest continuous test available, and any
behaviour too annoying to live with shows up on the author first.

Then, smallest blast radius first: `vilos92.com` → `greglinscheid.com` → `gdex` → `grynthia.cat` →
`scriptlancer` (monorepo last; per-workspace overrides make it the most complex).

Per repo: run `--write`, **commit the bulk reformat alone with no other changes**, then read the diff.
Grep specifically for changed lines containing `ignore`, `disable`, `expect-error`, `@example`, `|`,
`+--`, or box-drawing characters — those are the mangles that matter. Every mangle becomes a new fixture
in this repo, not a one-off disable in theirs.

Tune `orphanMinRatio` across all five at 0.2 / 0.3 / 0.4 before locking it.

### Hook wiring

Two separate jobs here, often conflated: a **hook installer** (writes `.git/hooks` or sets
`core.hooksPath`) and a **staged-file runner** (filters to staged files, runs commands, re-stages what
changed). `husky` and `simple-git-hooks` are installers. `lint-staged` is a runner. `lefthook` is both.

**Use `lint-staged` as the runner. This is not the default-by-inertia choice — it's the correct one for
this specific tool.** `comment-fmt --write` rewrites files during the hook, which puts all the risk in
re-staging and partial-staging behaviour:

- `lint-staged` re-stages modified files **by default**, and handles partially staged files
  (`git add -p`) by stashing the unstaged remainder, running, and restoring. That path is well-worn.
- `lefthook` requires `stage_fixed: true` explicitly, **per command**, and it is off by default. Forget
  it and the reformat silently never reaches the commit. It also only works on `pre-commit`. There is an
  open issue (evilmartians/lefthook#1369) about unstaged changes being lost when patch restore fails
  after a formatter rewrites a file — an acceptable risk for a linter that only reports, a bad one for a
  tool whose entire job is rewriting files.

Version reality as of July 2026: `lint-staged` 17.2.0 (published 2026-07-23, actively maintained),
`lefthook` 2.1.10 (2026-07-08, actively maintained), `husky` 9.1.7 (**last published 2024-11-18**). Husky
is the stale component, not lint-staged — but husky is ~2 kB that does almost nothing, so its staleness
is low-risk. **If a repo already has husky + lint-staged, leave it alone.** Only use `simple-git-hooks`
where you're wiring from scratch.

```jsonc
// package.json — Biome repos (gdex, grynthia.cat)
{
  "devDependencies": {"comment-fmt": "^0.1.0"},
  "simple-git-hooks": {"pre-commit": "npx lint-staged"},
  "lint-staged": {
    "*.{ts,tsx,js,jsx,css,scss,html}": [
      "biome check --write --no-errors-on-unmatched",
      "comment-fmt --write" // LAST — see ordering note below
    ]
  }
}
```

**Ordering: `comment-fmt` runs LAST, after the formatter.** (This reverses the guidance in earlier drafts
of this plan; the earlier version was wrong.)

The reason is indentation. Biome and oxfmt re-indent comments as part of formatting code around them, and
our width math depends on the comment's _final_ indentation. Run first, and a comment we wrapped to
exactly 110 becomes 112 when the formatter indents its enclosing block by two more — we'd then rewrap it
on the _next_ commit, producing a spurious diff. Run last and the indentation is already settled, so the
width calculation is correct the first time.

The argument for running first was that the formatter would act as a free parse-check on our output,
catching a lexer bug that corrupted code. That safety net is real but redundant: the code-invariance
property (§9.1.4) is a strictly stronger check, runs inside the tool, and doesn't depend on hook ordering.
Don't trade correct width math for a weaker version of a guarantee we already have.

If a repo is already standardised on lefthook, this is the equivalent — note `stage_fixed`:

```yml
pre-commit:
  commands:
    comment-fmt:
      glob: '*.{ts,tsx,js,jsx,css,scss,html}'
      run: comment-fmt --write {staged_files}
      stage_fixed: true # REQUIRED — off by default; without it the reformat never lands
```

```jsonc
// CI — one extra token on the existing script
"lint": "biome ci . && comment-fmt --check ."   // gdex, grynthia.cat
"lint": "vp lint && comment-fmt --check ."      // the three vp repos
```

**Ordering matters:** `comment-fmt` runs _before_ the formatter, so Biome/oxfmt gets the last word and
can't be surprised by our output. Verify on a real file that the two converge — if `biome check --write`
reflows what we just wrote, or vice versa, you have a fight and must narrow our scope.

### README

Once the tool is operational (not before -- a README describing behavior that doesn't exist yet is worse
than a thin one), write a proper one. Look at other well-regarded CLI/formatter READMEs for structural
inspiration (what order they cover install / usage / config / rationale in, how much they lead with
"why" vs "how") rather than inventing a structure from nothing. Beyond whatever that survey turns up,
make sure it covers:

- **Motivation, refined from §1's one-liner.** The real story has two parts, and both are worth stating
  plainly rather than compressing into one sentence: a careful human writing a comment by hand tends to
  self-balance it reasonably well as they type. An agent generating the same comment often doesn't --
  it'll happily emit a comment that blows past the configured print width, or wraps unevenly, because it
  isn't tracking column position the way a human's eyes are. That's the sharper motivation, not just
  "agents don't know the print width."
- **A comparison table.** Two categories belong in it, not one: dedicated comment-reflow tools (this
  project's own upstream reference, `eslint-plugin-comment-length`, is one; look for others) _and_ how
  the mainstream formatters handle comments today, since most people's mental model of "my formatter
  handles this" is wrong and the table should correct it -- Prettier explicitly refuses to reflow
  comments at all (by design, see §8.4's framing of why), gofmt leaves comment text untouched always,
  and rustfmt/clang-format/Biome each need their own direct check rather than an assumed answer, since
  none of them are as clearly documented as Prettier's stance. Verify every row against the tool's
  actual current behavior/docs when writing this, not from memory -- these move.
- **This isn't only for agent-authored code.** A human mid-review who just wants a deterministic way to
  "hold the line" on a width limit benefits too, independent of who wrote the comment. Say so. But also
  be honest about what made this hard: making comment reflow a _deterministically correct_ operation --
  never corrupting code, never mangling a hand-aligned table, converging instead of oscillating -- is
  the actual engineering problem this project spent most of its effort on (see §7's overflow-only gate
  and §9's testing strategy), not a solved-by-construction given. The README should reflect that this
  was genuinely hard to get right, not imply it's a trivial wrapper around an existing idea.

---

## 12. Phases

**Phase 1 — Scaffold.** `vp create`, house style config, snapshot harness, empty fixture dirs, CI running
`vp test` + `vp lint`. The harness comes first so there is never friction against adding a case.

**Phase 2 — Core + JS lexer.** `core/wrap.ts` and `lang/js.ts`. Write the code-invariance property test
(§9.1.4) before trusting the lexer on anything real. Done when the §9.2 JS corpus and all four invariants
pass. This is the bulk of the work.

**Phase 3 — CLI.** `--check` (exit 1 on diff), `--write`, `--diff`. Discovery per §10. Ship `0.1.0`; wire
into this repo's own hook.

**Phase 4 — Differential corpus.** §9.3. Expect this to find real bugs — budget time to fix them, not
just to build the harness.

**Phase 5 — Block reshape.** `core/reshape.ts`. Keep the single-line and force-multiline thresholds as
two constants even when equal — the gap is a hysteresis band that stops boundary comments flapping
between forms on every edit.

**Phase 6 — CSS + HTML lexers.** Should be small if `core/` stayed language-agnostic. If it isn't small,
the abstraction leaked in Phase 2 — fix that rather than special-casing.

**Phase 7 — Rollout and tuning.** §11.

**Phase 8 — Astro (unscheduled).** Not committed to yet, no target date -- captured here so the idea has
a home instead of living only in a conversation. See §4's architecture note for the shape a `lang/astro.ts`
would likely take. Revisit once Phase 7 is done and `greglinscheid.com`'s rollout has surfaced whether
`.astro` comments are common enough there to be worth it.

---

## 13. Risks

1. **The JS lexer, not the wrapper, is the real risk.** String/template/regex skipping is where a
   hand-rolled lexer silently corrupts files. The code-invariance property (§9.1.4) plus the differential
   corpus (§9.3) are the two things standing between you and a bad commit. Do not skip either.
2. **Formatter fights.** If Biome or oxfmt reflows what we write, the hook oscillates. Test convergence
   explicitly, repo by repo.
3. **`--write` in a pre-commit hook modifies staged files.** Confirm `lint-staged` re-stages (it does by
   default) and that a failed run leaves the tree clean.
4. **Display-width correctness is a rabbit hole.** If no repo has meaningful non-ASCII comment content,
   use `.length`, document the choice, move on. No grapheme-segmentation dependency.
5. **HTML is the least-specified language here.** `<script>`/`<style>` delegation and `--` handling are
   fiddly. If Phase 6 sprawls, ship CSS and defer HTML.
6. **Dependency creep is the silent performance risk.** The 93 ms measurement assumes zero runtime deps.
   Guard it with a CI check that fails if `dependencies` is non-empty.

---

## 14. Appendix: seed test corpus

**A starting corpus, not the target.** §9.2 still applies — generate far more than this. These exist so
the agent starts from a floor that already contains known-hard cases rather than inventing the easy ones
first.

Cases marked ⚡ were **empirically verified** to break a naive lexer (one that skips strings and template
literals but does not track regex context or template interpolations). They are not hypothetical.

### 14.1 JS lexer — verified breakages

These five were run against a naive implementation and failed. Write them first.

| Case                            | Source                                     | Correct      | Naive lexer produced                             |
| ------------------------------- | ------------------------------------------ | ------------ | ------------------------------------------------ |
| ⚡ regex-containing-slashes     | `const r = /https:\/\//; // real`          | `// real`    | `//; // real` — **corrupts code into a comment** |
| ⚡ regex-containing-block-open  | `const r = /a\/*b/; // real`               | `// real`    | `/*b/; // real` — **corrupts, consumes to EOF**  |
| ⚡ comment-inside-template-expr | ``const t = `${a /* real */ + b}`;``       | `/* real */` | _(nothing)_ — silent miss                        |
| ⚡ nested-template-3-deep       | ``const t = `${`${`${a /* real */}`}`}`;`` | `/* real */` | _(nothing)_ — silent miss                        |
| ⚡ template-with-nested-braces  | ``const t = `${ {a:1}.a /* real */ }`;``   | `/* real */` | _(nothing)_ — silent miss                        |

Two distinct failure classes, and they are not equally bad. **Regex mishandling corrupts** — the tool
rewrites real code as a comment, which is the worst thing this project can do. **Template interpolation
mishandling merely misses** — a comment goes unformatted, which is harmless. Prioritise regex context
accordingly.

### 14.2 JS lexer — pass-by-accident

These are handled correctly by a naive lexer, but only coincidentally — a different implementation can
easily fail them, so they belong in the suite as regression guards, not as proof of correctness.

`const r = /[/]/; // real` (slash in character class) · `const r = /a\/\/b/; // real` ·
`if (a) /re/.test(b); // real` (regex vs division after `)`) · `const x = arr[0] / 2; // real` ·
`const x = (a) / (b) / c; // real` · `const s = "he said \"hi\""; // real` ·
`const s = "back\\"; // real` (string ending in escaped backslash) ·
`const s = "a" +\n "// not"; // real` · `const el = <div t="// not a comment" />;` ·
`/*a*//*b*/` (two comments, not one) · `const x = a / b; const r = /c/; // real` (division then regex on
one line)

### 14.3 JS lexer — additional cases to write

Ambiguity: division vs regex after `return`, after `typeof`, after a template literal, after `}` closing
a block vs closing an object literal · regex with flags followed by `.source / 2` · `a++ /re/` · ASI
interactions where a comment sits between `return` and its value.

Termination: unterminated block comment at EOF · unterminated string at EOF · unterminated template at
EOF · unterminated regex at EOF · `/*` inside a line comment on the last line of the file.

Syntax edges: `<!--` and `-->` (legacy Annex B line comments in sloppy scripts — decide explicitly
whether to support; document either way) · hashbang `#!/usr/bin/env node` on line 1 · `#private` class
fields (must not be confused with hashbang) · JSX comment inside a fragment · comment between a decorator
and its class · TS `satisfies` / generic arrow `<T,>(x) => x` where `<` could read as JSX.

### 14.4 Directives — one case each, at wrapping length

Every entry in §8.1, in a comment long enough that it _would_ wrap, asserted unchanged. The point of a
per-entry fixture rather than one grouped test is that a partial regression stays visible.

`// eslint-disable-next-line @typescript-eslint/no-explicit-any -- long trailing rationale that pushes
this well past one hundred and ten columns` · same for `oxlint-disable-next-line`,
`biome-ignore lint/suspicious/noExplicitAny: <reason>`, `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`,
`prettier-ignore`, `oxfmt-ignore`, `v8 ignore next`, `c8 ignore start`, `istanbul ignore next`,
`webpackChunkName: "..."`, `@vite-ignore`, `/* #__PURE__ */`, and in CSS
`/* stylelint-disable-next-line declaration-no-important */`.

Also: a directive **inside** an otherwise-wrappable block comment (only that line is protected, or the
whole block is — pick one and test it), and a directive-looking string that is not one (`// this mentions
eslint-disable in prose and should still wrap`) — that last one is a deliberate trap for an over-eager
`includes()` check.

### 14.5 Structure preservation

Each of these must survive untouched, and each must be tested **twice: once under the width limit and
once over it.** The under-limit copy proves the §7 step 0 overflow-only gate holds — that is the case
that protects real codebases, and it must pass byte-for-byte. The over-limit copy proves the §8.3
heuristic catches what the gate cannot. A suite that only tests the over-limit variants is testing the
weaker guarantee.

Also required here: for every structure below, a variant carrying `comment-fmt-ignore` (§8.4), asserted
unchanged regardless of width.

ASCII table with `|` separators · table with space-aligned columns · box-drawing characters (`┌─┐│└┘`) ·
a two-column key-value list aligned with runs of spaces · markdown bullet list with hanging indents ·
nested markdown list · numbered list · fenced code block inside a JSDoc description · `@example` block
containing its own comments · a license banner with a leading `!` (`/*! ... */`) · a long `@param`
description that wraps · mixed tag lines and prose in one block · a JSDoc block that is only tags, no
description · an ASCII diagram with intentional trailing spaces.

### 14.6 Width and encoding

Exactly at `maxLength`, one under, one over · a line that hits the limit only after the `*` prefix is
added · CJK text (2 display columns per char) · emoji · ZWJ emoji sequence (family, flags) · combining
diacritics · right-to-left text · tabs at line start · tabs mid-line · mixed tabs and spaces · CRLF
throughout · CRLF on some lines only · no trailing newline · leading BOM · non-breaking spaces inside a
comment.

### 14.7 Degenerate

Empty file · file containing only a comment · zero-byte file · `//` with nothing after it · `/**/` ·
`/***/` · whitespace-only comment body · a single word longer than `maxLength` · one 5,000-character
token · 500 consecutive `//` lines · a comment on the very last line with no newline · deeply indented
comment where indent alone approaches the limit (indent + prefix leaves no room — must not loop forever).

### 14.8 Idempotency traps

Cases specifically designed to make a fixer oscillate. Assert `fmt(fmt(x)) === fmt(x)` on each:

A comment whose reflow lands exactly at the boundary between single-line and multi-line shape · a body
where the orphan guard pulls a word back and the resulting line then overflows · a block where reshape
wants single-line but width wants multi-line (this is why §12 Phase 5 keeps two thresholds with a
hysteresis gap — write the fixture that proves the gap works) · a comment already at the target width
where re-running must be a no-op · a table-like block adjacent to a wrappable block in the same comment.

### 14.9 CSS

`background: url(data:image/svg+xml;base64,Zm//8v);` — `//` inside a data URL, not a comment ·
`content: "/* not a comment */";` · `content: "*/";` followed by a real `/* comment */` · SCSS `//`
comment at end of a declaration line · SCSS `//` inside a string · comment inside a media query ·
comment between selector and `{` · comment inside a `@supports` condition · nested SCSS with comments at
each level · a comment containing `*/` escaped in some way (there is no escape in CSS — assert we never
emit one).

### 14.10 HTML

`<!-- normal -->` · `<!-- contains -- double hyphen -->` (must never emit invalid HTML) ·
`<!--> ` (degenerate short form) · comment inside `<pre>` (untouched) · comment inside `<textarea>` ·
comment inside `<script>` → delegate to the JS lexer · comment inside `<style>` → delegate to the CSS
lexer · `<a href="<!-- not a comment -->">` (attribute value) · conditional comment `<!--[if IE]>` · SSI
directive `<!--#include virtual="..." -->` · comment spanning the whole document before `<!doctype>` ·
unclosed comment at EOF.

### 14.11 Differential corpus targets

For §9.3, clone fresh and run `--check` over: `microsoft/TypeScript`, `vuejs/core`, `vitejs/vite`,
`rollup/rollup`, `biomejs/biome` (its JS surface), `eslint/eslint`, `facebook/react`, `sveltejs/svelte`,
`nodejs/node` (lib/), `tailwindlabs/tailwindcss`, plus `node_modules` from all five consumer repos.

Run property 9.1.4 (code invariance) over every file. **A single violation anywhere in that corpus is a
lexer bug worth stopping the world for** — it means the tool will silently corrupt somebody's source.
Everything else in this appendix is about output quality; that one property is about not doing damage.
