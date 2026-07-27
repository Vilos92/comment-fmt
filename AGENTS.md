<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Agent notes

Living conventions for this repo. Ask whether new habits belong here vs `README.md`.

`PLAN.md` is the architecture and phasing source of truth -- code comments citing "plan §N" mean that
document. Check it before proposing a structural change or re-deriving something it already settled.
**Once the tool is operational (`PLAN.md`'s own Status section tracks this), delete it** and sweep every
`plan §N` citation out of the codebase's comments first, rewriting each into the rationale it was standing
in for. It's a handoff document for building the tool, not permanent project documentation.

## Toolchain

**Bun-first** for installs and `package.json` scripts (`bun install`, `bun run …`, `bunx …`). Day-to-day tooling is **`vp`** per the Vite+ section above. Prefer the Bun (or `vp`) equivalent when upstream docs show `npm` / `pnpm` / `npx`.

## TypeScript

- Prefer **`type` over `interface`** unless you need declaration merging (we do not).
- Prefer **`undefined` over `null`**. Model absence as `undefined`; no `?? null` unless a type contract requires `null`.
- **`??` vs `||`:** **`??`** for nullish default only; **`||`** for booleans / deliberate truthiness. Empty-string-as-absent → named helper, not `value || fallback`.
- No **`x ?? undefined`** when `x` is already `T | undefined` without `null`.
- **Exports:** module-private until another file imports it, or it's part of the deliberate public API (`src/index.ts`).
- **`?` vs `| undefined`:** optional props (`prop?:`) for keys callers often omit; internal call sites prefer required `prop: T | undefined`.
- **Readonly arrays** for read-only / pass-through data (`readonly T[]`).

## Imports

- **Include the `.ts` suffix** on relative imports (`./wrap.ts`, not `./wrap`). `tsconfig.json` sets `allowImportingTsExtensions`, and the `import/extensions` lint rule in `vite.config.ts` gates it — `vp check` fails on an extensionless relative import. Package imports (`node:fs`, `vite-plus/test`) are exempt (`ignorePackages`).
- Use **`import type`** for type-only imports (`verbatimModuleSyntax` enforces this).

## File layout (section comments)

Section markers are **multi-line block comments** (sentence-case label + period), with a blank line before and after, and between the comment and the code below it:

```
/*
 * Types.
 */
```

Do **not** collapse these to single-line `/* Types. */`. Skip markers entirely on lean single-export files where they'd add ceremony only. Order (omit unused; no empty **Types.** / **Helpers.**):

Precede every section marker with `// comment-fmt-ignore` (plan §8.4's escape hatch), once this repo's own pre-commit hook starts running `comment-fmt` on it (Phase 3 onward). Without it, `comment-fmt` collapses a short marker like `Types.` to single-line on its own, since a bare section label is syntactically indistinguishable from ordinary short prose it's supposed to collapse (plan §1, §12 Phase 5) — there's no signal in the text itself marking it as structural. This was found by dogfooding the tool on its own source the moment block-reshape landed.

1. **Types.** · **Constants.**
2. **Entry.** for the module's primary export, or **Config.** for `vite.config.ts`. Not **Script.** /
   **Component.** / **Styles.** — those are scriptlancer/greglinscheid.com labels for browser bootstrap
   files, Preact components, and vanilla-extract stylesheets, none of which this project has.
3. **Helpers.** — always last

**Tests:** the same markers apply once a test file has real structure (arbitraries/generators, shared helper functions, fixtures) beyond a single `describe`/`test` block. **Constants.** (generators, fixtures) → **Script.** or **Tests.** (the `describe`/`test` bodies) → **Helpers.**. A short, single-purpose test file can skip markers the same as any other lean file.

## Code style

- Functional style; early returns; small helpers over deep nesting.
- Prefer **`map` / `filter` / `reduce`**; no **`forEach`** — use **`for`…`of`** (or indexed `for`) when imperative.
- **`no-nested-ternary`** and **`curly: all`** are Oxlint errors (via `vp check`) — always brace blocks, no nested ternaries.

## Comments

- **Why over what.** Drop comments that only restate mechanics the code already shows.
- **State intent positively.** Prefer `// ensures Y` over `// prevents X` when the code already makes X impossible.
- **Layer once.** Put shared why on a constant, type field, or entry closure. Don't repeat it at every call site.
- **A comment carries its own why**, never just a pointer to this file or other contributor docs. Referencing other code (a sibling function, a fixture) is fine.
- **JSDoc** on exports and non-trivial helpers when the contract isn't obvious. Often one crisp line is enough. Don't document module-private types.
- In prose, backtick **identifiers** (`targetLength`), not section headers.
- **Default to separate sentences over semicolons or em dashes joining clauses.** Either is fine occasionally for a tight parenthetical, but overuse gives the codebase a heavy editorial voice.

## Naming

- **Booleans:** predicate prefixes (`is`, `has`, `should`, `can`, …) for locals, params, and fields — not bare adjectives or state nouns.
- **Boolean-returning functions:** name them so the call reads as a question (`canApply`, `checkIsUrl`). Prefer `can` / `check` / `should` over `getIs…`, which reads like a stored-flag accessor. Reserve bare `is` / `has` on functions for real TypeScript type guards (`x is Foo` return types) only; a plain boolean-returning check gets `checkIsX` / `checkHasX` instead.
- **`compute` / `calc`** for calculated non-boolean results.
- **Locals:** readable names, not `e` / `x` unless scope is tiny.
- **Name for what a thing is, not where it lives.** When a folder or module already conveys context, don't restate it as an identifier prefix.

## Fail fast

- Throw with a clear message rather than run in a misleading state.
- Avoid plausible-looking placeholders for values the tool cannot function without.

## Validation

Non-trivial diff, or before commit: `vp check` then `vp test`. The CI jobs map onto local commands 1:1:

| CI job      | Local command                                                                    |
| ----------- | -------------------------------------------------------------------------------- |
| `fmt`       | `vp run fmt:check`                                                               |
| `lint`      | `vp run lint`                                                                    |
| `typecheck` | `vp run typecheck`                                                               |
| `check`     | `vp run check`                                                                   |
| `test`      | `vp run test` — currently fails upstream regardless of local changes, see README |
| `build`     | `vp run build`                                                                   |

## Keeping this file useful

When we lock in a new convention, ask whether it should be added or tightened in `AGENTS.md`.
