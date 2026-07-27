/*
 * Constants.
 */

// Directives that must never be reflowed, even when they overflow. Wrapping one changes its
// text, and for the tool-directive entries that silently stops the tool from doing anything
// (e.g. a wrapped `oxlint-disable-next-line some-rule` no longer disables the rule while CI stays
// green). Matched by prefix against each line's trimmed content, not by substring search
// anywhere in the comment. `// this mentions eslint-disable in prose` must still wrap, and only
// a prefix match tells the two apart. `-next-line` / `-disable`-family suffixes don't need
// separate entries: they share the same prefix as their base directive.
const DIRECTIVE_MARKERS: readonly string[] = [
  // ESLint / Oxlint.
  'eslint-disable',
  'eslint-enable',
  'oxlint-disable',
  // Stylelint.
  'stylelint-disable',
  'stylelint-enable',
  // TSLint (legacy).
  'tslint:disable',
  'tslint:enable',
  // Biome.
  'biome-ignore',
  // TypeScript.
  '@ts-expect-error',
  '@ts-ignore',
  '@ts-nocheck',
  // Formatters.
  'prettier-ignore',
  'oxfmt-ignore',
  // Coverage.
  'v8 ignore',
  'c8 ignore',
  'istanbul ignore',
  // Minifier / bundler hints.
  '#__PURE__',
  '@__PURE__',
  'webpackChunkName',
  'webpackPrefetch',
  'webpackPreload',
  'webpackMode',
  'webpackExports',
  'webpackInclude',
  'webpackExclude',
  '@vite-ignore',
  // HTML.
  '[if ', // Conditional comments: <!--[if IE]-->
  '#include', // SSI: <!--#include virtual="..." -->
  // This tool's own escape hatch (plan §8.4). Self-protecting, so a long ignore directive is
  // never itself wrapped into something that no longer matches the syntax it's documented with.
  'comment-fmt-ignore'
];

// GFM table delimiter row: only pipes, colons, dashes, and whitespace, with at least one pipe.
const GFM_DELIMITER_ROW = /^[\s|:-]+$/;
const HAS_PIPE = /\|/;

const BOX_DRAWING_CHARS = /[─│┌┐└┘├┤┬┴┼]/;
const ASCII_BOX_OR_TREE = /(\+-{2,}|\|--|├──|└──|`--)/;

const RUN_OF_SPACES = / {2,}/g;

const MIN_ALIGNED_LINES = 3;

/*
 * Entry.
 */

/**
 * `true` if `line` starts (after trimming) with a known tool directive, or one from
 * `extraDirectives` (plan §6 config surface). Operates on a single line, since a directive inside
 * an otherwise-reflowable multi-line block should only protect that one line. See `blocks.ts`.
 */
export function checkIsDirective(line: string, extraDirectives: readonly string[] = []): boolean {
  const trimmed = line.trim();
  return (
    DIRECTIVE_MARKERS.some(marker => trimmed.startsWith(marker)) ||
    extraDirectives.some(marker => trimmed.startsWith(marker))
  );
}

/** ESLint `max-len`'s URL heuristic: a char that isn't `:`/`/`/`?`/`#` immediately before `://`,
 * followed by a char that isn't `?`/`#`. Loose by design. A false positive just leaves a line
 * unwrapped, which is the safe direction (plan §7 step 0 is the real safety net either way). */
export function checkIsUrl(text: string): boolean {
  return /[^:/?#]:\/\/[^?#]/u.test(text);
}

/** `true` for a JSDoc-style tag line (`@param foo - ...`), after leading whitespace. Tag lines
 * are wrap boundaries in `blocks.ts` and are never merged with surrounding prose. */
export function checkIsTagLine(line: string): boolean {
  return line.trimStart().startsWith('@');
}

/** `true` for a fenced-code boundary (``` ```` ```), which opens or closes a protected region in
 * `blocks.ts` as a matched pair. Content between two fence lines is passed through untouched
 * regardless of width, the same way step 0 protects an already-fitting comment. */
export function checkIsFenceLine(line: string): boolean {
  return line.trim().startsWith('```');
}

/** `true` for an `@example` tag. Unlike a fence, this isn't a matched open/close pair. A second
 * `@example` starts its own new protected region rather than closing the first one. JSDoc has no
 * closing marker for `@example`. It runs until the next tag or the comment ends. */
export function checkIsExampleTag(line: string): boolean {
  return line.trim().startsWith('@example');
}

/**
 * Best-effort, fail-safe detector for tabular/aligned content across a candidate block's lines
 * (plan §8.3). Two tiers: a precise GFM table check (a pipe-bearing line directly followed by a
 * valid delimiter row), and a looser heuristic bundle (box-drawing/tree characters, or `|`/space
 * runs that land on the same column across `MIN_ALIGNED_LINES`+ lines). Returns `false` (never
 * touch the block) whenever a check is inconclusive. A false positive here only costs one
 * unformatted comment, a false negative can destroy hand-aligned content.
 */
export function checkIsTableLike(lines: readonly string[]): boolean {
  return (
    checkHasGfmDelimiterRow(lines) ||
    lines.some(line => BOX_DRAWING_CHARS.test(line) || ASCII_BOX_OR_TREE.test(line)) ||
    checkHasAlignedColumns(lines, '|') ||
    checkHasAlignedSpaceRuns(lines)
  );
}

/*
 * Helpers.
 */

function checkHasGfmDelimiterRow(lines: readonly string[]): boolean {
  for (let i = 1; i < lines.length; i += 1) {
    const delimiterRow = lines[i] as string;
    const headerRow = lines[i - 1] as string;
    if (GFM_DELIMITER_ROW.test(delimiterRow) && HAS_PIPE.test(delimiterRow) && HAS_PIPE.test(headerRow)) {
      return true;
    }
  }
  return false;
}

function columnsOf(line: string, char: string): number[] {
  const columns: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === char) {
      columns.push(i);
    }
  }
  return columns;
}

/** `true` if at least one column position of `char` is shared by `MIN_ALIGNED_LINES`+ lines. */
function checkHasAlignedColumns(lines: readonly string[], char: string): boolean {
  const countByColumn = new Map<number, number>();
  for (const line of lines) {
    for (const column of columnsOf(line, char)) {
      countByColumn.set(column, (countByColumn.get(column) ?? 0) + 1);
    }
  }
  return [...countByColumn.values()].some(count => count >= MIN_ALIGNED_LINES);
}

function checkHasAlignedSpaceRuns(lines: readonly string[]): boolean {
  const countByColumn = new Map<number, number>();
  for (const line of lines) {
    for (const match of line.matchAll(RUN_OF_SPACES)) {
      const column = match.index;
      countByColumn.set(column, (countByColumn.get(column) ?? 0) + 1);
    }
  }
  return [...countByColumn.values()].some(count => count >= MIN_ALIGNED_LINES);
}
