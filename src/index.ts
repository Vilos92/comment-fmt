import {splitIntoBlocks} from './core/blocks.ts';
import {
  DEFAULT_FORCE_MULTILINE_MIN_WIDTH,
  DEFAULT_MAX_LENGTH,
  DEFAULT_SINGLE_LINE_MAX_WIDTH
} from './core/constants.ts';
import {measure} from './core/measure.ts';
import {checkIsCollapsible, decideBlockShape, type BlockShape} from './core/reshape.ts';
import {wrap, type WrapOptions} from './core/wrap.ts';
import {findComments as findCommentsCss} from './lang/css.ts';
import {findComments as findCommentsJs} from './lang/js.ts';
import type {Comment} from './lang/types.ts';

// comment-fmt-ignore
/*
 * Types.
 */

/** Every language `format()` can reflow comments for (plan §4). */
export type Lang = 'js' | 'css';

export type FormatOptions = WrapOptions & {
  /**
   * Which lexer to find comments with (plan §4). Defaults to `'js'` so every existing caller
   * (the JS/TS/JSX/TSX-only callers this library shipped with before CSS support existed) keeps
   * working unchanged.
   */
  readonly lang?: Lang;
  /** Plan §12 Phase 5's single-line collapse threshold. Not part of the §6 config surface. */
  readonly singleLineMaxWidth?: number;
  /** Plan §12 Phase 5's force-multiline threshold. Not part of the §6 config surface. */
  readonly forceMultilineMinWidth?: number;
};

// comment-fmt-ignore
/*
 * Constants.
 */

/**
 * Default continuation-line prefix for a block comment being expanded from single-line to
 * multi-line shape, where there's no existing second line to detect a convention from. Aligns
 * the `*` one column right of the comment's own `/`, matching common JSDoc style.
 */
const DEFAULT_BLOCK_PREFIX = '* ';

/**
 * File-level escape hatch (plan §8.4): honored only within a file's first `IGNORE_FILE_LINE_WINDOW`
 * physical lines, so a stray mention deep in a long file can't silently opt the whole file out.
 * `\b` after the literal keeps a hypothetical `comment-fmt-ignore-fileX` from matching.
 */
const IGNORE_FILE_MARKER = /comment-fmt-ignore-file\b/;

const IGNORE_FILE_LINE_WINDOW = 5;

/**
 * Per-comment escape hatch (plan §8.4): matches `comment-fmt-ignore` wherever it appears in a
 * comment's body, for both the inline form (skip this comment) and as the whole content of a
 * preceding standalone comment (skip the next one). Excludes `comment-fmt-ignore-file` so that
 * marker, found outside its line window, doesn't also register as this one.
 */
const IGNORE_MARKER = /comment-fmt-ignore(?!-file)\b/;

/**
 * A standalone comment whose entire (trimmed) content is exactly this, optionally followed by a
 * `-- reason` or `: reason` that the tool ignores, is the preceding-line form of the escape hatch.
 */
const IGNORE_MARKER_WHOLE_COMMENT = /^comment-fmt-ignore(\s*(--|:)\s*\S.*)?$/;

// comment-fmt-ignore
/*
 * Entry.
 */

/**
 * Reflows every comment in `source` to fit within `options.maxLength` columns, without touching
 * anything else. Non-comment code is guaranteed byte-for-byte identical (see `test/props`,
 * property 9.1.4). `options.lang` picks the lexer (plan §4); every reflow decision after that
 * point is entirely language-agnostic, since every lexer returns the same `Comment` shape.
 *
 * A comment whose every physical line already fits is returned completely untouched, not just
 * "unchanged content re-serialized the same way." This function slices the original source
 * around comments it doesn't need to touch, rather than reconstructing them, so there's no path
 * by which reflow logic could introduce a whitespace difference in already-fitting content. The
 * same applies, unconditionally, to any comment covered by the plan §8.4 escape hatch below.
 */
export function format(source: string, options: FormatOptions = {}): string {
  const findCommentsForLang = options.lang === 'css' ? findCommentsCss : findCommentsJs;
  const comments = findCommentsForLang(source);
  if (checkHasFileIgnore(source, comments)) {
    return source;
  }

  let result = source;

  // Reverse order: replacing a later comment first keeps every earlier comment's [start, end)
  // offsets, computed against the original `source`, valid against `result` at each step.
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i] as Comment;
    if (checkIsIgnored(source, comments, i)) {
      continue;
    }
    const replacement = reflowComment(source, comment, options);
    result = result.slice(0, comment.start) + replacement + result.slice(comment.end);
  }

  return result;
}

// comment-fmt-ignore
/*
 * Helpers.
 */

/**
 * `true` if a `comment-fmt-ignore-file` marker (plan §8.4) itself sits within the file's first
 * `IGNORE_FILE_LINE_WINDOW` lines. Checked once, up front, so a matching file short-circuits to a
 * straight return rather than being walked comment by comment for no reason.
 *
 * Locates the marker text's own offset inside the comment, not just the comment's start: a
 * multi-line block comment can start within the window while the marker itself sits many lines
 * deeper in its body, and gating on the comment's start line alone would let that comment carry
 * the marker arbitrarily far into the file, well outside the window the marker is supposed to be
 * confined to.
 */
function checkHasFileIgnore(source: string, comments: readonly Comment[]): boolean {
  for (const comment of comments) {
    const content = rawContentOf(source, comment);
    const match = IGNORE_FILE_MARKER.exec(content);
    if (!match) {
      continue;
    }
    const markerOffset = comment.start + comment.open.length + match.index;
    if (lineOf(source, markerOffset) < IGNORE_FILE_LINE_WINDOW) {
      return true;
    }
  }
  return false;
}

/**
 * `true` if `comments[index]` is covered by the per-comment escape hatch (plan §8.4): either the
 * marker appears inline in its own body, or the comment immediately before it is a standalone
 * `comment-fmt-ignore` marker with nothing but a single line break between the two. The adjacency
 * check is deliberately strict (no blank line permitted) to match how directive comments like
 * `eslint-disable-next-line` are conventionally read: applying to the very next line, not "soon".
 */
function checkIsIgnored(source: string, comments: readonly Comment[], index: number): boolean {
  const comment = comments[index] as Comment;
  if (IGNORE_MARKER.test(rawContentOf(source, comment))) {
    return true;
  }

  const previous = comments[index - 1];
  if (!previous || !previous.ownLine) {
    return false;
  }
  if (!IGNORE_MARKER_WHOLE_COMMENT.test(rawContentOf(source, previous).trim())) {
    return false;
  }
  return /^[ \t]*\n[ \t]*$/.test(source.slice(previous.end, comment.start));
}

function rawContentOf(source: string, comment: Comment): string {
  return source.slice(comment.start + comment.open.length, comment.end - comment.close.length);
}

function lineOf(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

function reflowComment(source: string, comment: Comment, options: FormatOptions): string {
  const raw = source.slice(comment.start, comment.end);
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  if (comment.kind === 'line') {
    return fitsWithinLimit(raw, comment.indent, maxLength) ? raw : reflowLineComment(comment, raw, options);
  }

  // Block comments always run through reflowBlockComment, even when every physical line already
  // fits maxLength: line comments have only one shape, so "every line fits" is the whole answer,
  // but a block comment also has a shape decision (plan §1, §12 Phase 5) that "fits" alone doesn't
  // settle. A short multi-line comment that already fits line-by-line may still need to collapse
  // to single-line, so the same step-0 short-circuit line comments get can't apply here.
  // reflowBlockComment reconstructs byte-identical output on its own when nothing actually needs
  // to change, so this doesn't cost the "untouched majority case" the step-0 gate protects.
  return reflowBlockComment(comment, raw, options);
}

function fitsWithinLimit(raw: string, indent: number, maxLength: number): boolean {
  return raw.split('\n').every((line, idx) => measure(line) + (idx === 0 ? indent : 0) <= maxLength);
}

/**
 * Reflows a `//` comment: strips the opener and any leading whitespace, wraps the remaining text
 * with `wrap()`, then re-applies `//` to the first line and `<indent>//` to every continuation
 * line (a line comment has no per-line decoration of its own to preserve, unlike a block
 * comment's ` * `).
 */
function reflowLineComment(comment: Comment, raw: string, options: FormatOptions): string {
  const content = raw.slice(comment.open.length).replace(/^[ \t]+/, '');
  const prefixWidth = comment.indent + comment.open.length + 1; // Reconstructed as `// `.
  const wrapped = wrap([content], prefixWidth, options);
  if (
    wrapped.length === 1 &&
    wrapped[0] === content &&
    checkIsProtectedLine(content, options.extraDirectives)
  ) {
    // `wrap()` left this untouched specifically because it's protected (plan §8.1/§8.3), not
    // merely because it already fits its own budget. Reconstructing below hardcodes exactly one
    // space after `//`, which would silently collapse an atypical original spacing (e.g.
    // `//  eslint-disable ...`, two spaces) even though a protected directive must be preserved
    // byte-for-byte. Return the untouched original instead of risking that. Content that merely
    // fits (not protected) still goes through the normal reconstruction below, whose hardcoded
    // single space is what keeps *that* case within `maxLength` in the first place: an original
    // with extra internal spacing could otherwise measure over the limit by the outer check while
    // `wrap()`'s own budget (which assumes exactly one space) reads it as already fitting.
    return raw;
  }
  const indentStr = ' '.repeat(comment.indent);

  return wrapped
    .map((line, idx) => {
      const rendered = line.length > 0 ? `${comment.open} ${line}` : comment.open;
      return idx === 0 ? rendered : `${indentStr}${rendered}`;
    })
    .join('\n');
}

/**
 * Reflows a block comment (`/*`- or `/**`-opened) by extracting its content lines, deciding
 * whether it should collapse onto one physical line or take the multi-line starred form (plan §1,
 * §12 Phase 5), and reassembling the delimiters and continuation prefix around the result. The
 * opening and closing lines never carry content, per plan §1's block-shape rule: every content
 * line, including what would once have been "line 0" right after `open`, gets its own line with
 * `continuationPrefix` applied, exactly like every other content line. Handles both an already
 * multi-line comment (reusing its detected `linePrefix`) and one expanding from single-line for
 * the first time (synthesizing one via `DEFAULT_BLOCK_PREFIX`), and both a properly terminated
 * comment and an unterminated one (malformed/truncated source, which has no closing delimiter to
 * reconstruct and is never a collapse candidate).
 */
function reflowBlockComment(comment: Comment, raw: string, options: FormatOptions): string {
  const terminated = comment.close.length > 0;
  // When terminated, `inner` spans from right after `open` to right before the closing `*/`, so
  // for a multi-line comment its last split-by-`\n` entry isn't a content line at all. It's
  // whatever whitespace sits on the closer's own physical line before `*/` (e.g. the ` ` in
  // `\n */`). Folding that into content, as an earlier version of this function did, both
  // double-counts it as a blank content line and throws away the closer's real indentation. An
  // unterminated comment (malformed/truncated source, `comment.close === ''`) has no such line at
  // all. Every physical line is real content, and there's no closer to reconstruct.
  const inner = terminated
    ? raw.slice(comment.open.length, raw.length - comment.close.length)
    : raw.slice(comment.open.length);
  const physicalLines = inner.split('\n');
  const wasSingleLine = physicalLines.length === 1;
  const currentShape: BlockShape = wasSingleLine ? 'single-line' : 'multi-line';

  // A comment already spanning multiple physical lines carries its own detected `linePrefix`
  // (full leading whitespace already included, per `computeLinePrefix` in lang/js.ts). One that's
  // only overflowing now, and must expand from single-line, has no such line to detect a
  // convention from. Synthesize one aligned under the comment's second character (`DEFAULT_BLOCK_PREFIX`).
  const continuationPrefix = wasSingleLine
    ? `${' '.repeat(comment.indent + 1)}${DEFAULT_BLOCK_PREFIX}`
    : comment.linePrefix || `${' '.repeat(comment.indent + 1)}${DEFAULT_BLOCK_PREFIX}`;
  const closePrefix = wasSingleLine
    ? ' '.repeat(comment.indent + 1)
    : (/^\s*/.exec(physicalLines[physicalLines.length - 1] ?? '')?.[0] ?? '');

  const contentPhysicalLines = wasSingleLine || !terminated ? physicalLines : physicalLines.slice(0, -1);
  const rawContentLines = contentPhysicalLines.map((line, idx) =>
    idx === 0 ? line.replace(/^[ \t]+/, '') : stripLinePrefix(line, continuationPrefix)
  );
  // A multi-line comment's own line 0 (right after `open`) is empty by convention, not a
  // deliberate blank-line paragraph break the way one further down would be. Left in, it reads to
  // `splitIntoBlocks` as its own separate blank-line block, which both blocks collapsibility for
  // completely ordinary short comments and leaks a spurious blank continuation line into the
  // reconstruction below. Dropping it here is safe: `wrap()` pools every content line's words and
  // re-splits them regardless of original line boundaries, so this placeholder carries no
  // information a real blank line elsewhere in the body doesn't already carry on its own.
  const openerWasBare = !wasSingleLine && rawContentLines[0] === '';
  const contentLines =
    openerWasBare && rawContentLines.length > 1 ? rawContentLines.slice(1) : rawContentLines;
  const extraDirectives = options.extraDirectives ?? [];

  // Whether a real shape decision (plan §12 Phase 5) was even attempted, as opposed to skipped
  // because there was nothing to decide between (protected content, multiple blocks, or an
  // unterminated comment with no closer to complete a single-line form). Tracked so the
  // wrapped.length === 1 fallback below never overrides an explicit "stay multi-line" decision
  // made here just because the content also happens to fit the narrower continuation budget.
  const isCollapsible = terminated && checkIsCollapsible(contentLines, extraDirectives);
  if (isCollapsible) {
    const collapsed = tryCollapseToSingleLine(comment, contentLines, currentShape, options);
    if (collapsed !== undefined) {
      return collapsed;
    }
  }

  // Every content line now shares one budget: `continuationPrefix`'s width. Nothing is ever
  // attached to `open` any more, so there's no separate, wider budget line 0 alone would have
  // needed under the old opener-attaches-content design.
  const wrapped = wrap(contentLines, measure(continuationPrefix), options);
  if (!isCollapsible && openerWasBare && checkArraysEqual(wrapped, contentLines)) {
    // Nothing here needed to change: the opener was already bare (no plan §1 violation to fix)
    // and `wrap()` made no change to the content, so this comment would never have reached
    // `reflowBlockComment` at all before plan §12 Phase 5 started calling it unconditionally to
    // catch collapse candidates. Reconstructing below anyway would risk `.trimEnd()` silently
    // stripping a content line's meaningful trailing whitespace even though nothing about the
    // comment's shape or wrapping needed to change, contradicting this function's own documented
    // "byte-identical when nothing needs to change" guarantee. Return the untouched original.
    return raw;
  }
  if (
    wrapped.length === 1 &&
    wrapped[0] === contentLines[0] &&
    checkIsProtectedLine(contentLines[0] ?? '', extraDirectives)
  ) {
    // `wrap()` left this untouched specifically because it's protected (plan §8.1/§8.3), not
    // merely because it already fits its own budget. Reconstructing below (either form) would
    // lose the comment's original leading whitespace even though a protected directive must be
    // preserved byte-for-byte. Return the untouched original instead.
    return raw;
  }

  if (!isCollapsible && wrapped.length === 1) {
    // Content fits on one continuation-worthy line, but no shape decision ever ran above (not
    // collapsible: protected already handled, multiple blocks, or unterminated so there's no
    // closer to complete a single-line form with). Forcing the bare-opener multi-line shape here
    // regardless would be wrong: a comment that never needed more than one physical line to begin
    // with (a short unterminated `/* note`, or one surviving block among several) shouldn't be
    // split into an opener line plus a separate continuation line for no reason. Render it as one
    // physical line instead, with the same spacing convention the collapse path above uses. When
    // `isCollapsible` was true, `decideBlockShape` already had its say (including the hysteresis
    // gap keeping a comment multi-line on purpose) and must not be second-guessed here just
    // because this narrower continuation budget also happens to fit the content on one line.
    const rendered = terminated
      ? `${comment.open} ${wrapped[0]} ${comment.close}`
      : `${comment.open} ${wrapped[0]}`;
    return rendered;
  }

  const rest = wrapped.map(line => joinPrefixAndContent(continuationPrefix, line).trimEnd());
  const lines = terminated
    ? [comment.open, ...rest, `${closePrefix}${comment.close}`]
    : [comment.open, ...rest];

  return lines.join('\n');
}

/**
 * Attempts the plan §1/§12 Phase 5 single-line collapse for a comment whose content is a single
 * non-protected block (already confirmed by the caller via `checkIsCollapsible`). Returns
 * `undefined` when `decideBlockShape` calls for the multi-line form instead, so the caller falls
 * through to the normal reconstruction path.
 *
 * Both thresholds are clamped to `maxLength`: they default to values already `<= DEFAULT_MAX_LENGTH`,
 * but a caller configuring a smaller `maxLength` without also adjusting them (they're deliberately
 * not part of the §6 config surface) must never see a single-line result wider than the hard cap
 * they actually asked for.
 */
function tryCollapseToSingleLine(
  comment: Comment,
  contentLines: readonly string[],
  currentShape: BlockShape,
  options: FormatOptions
): string | undefined {
  const words = contentLines
    .join(' ')
    .trim()
    .split(/\s+/u)
    .filter(word => word.length > 0);
  if (words.length === 0) {
    return undefined;
  }

  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const singleLineMaxWidth = Math.min(options.singleLineMaxWidth ?? DEFAULT_SINGLE_LINE_MAX_WIDTH, maxLength);
  const forceMultilineMinWidth = Math.min(
    options.forceMultilineMinWidth ?? DEFAULT_FORCE_MULTILINE_MIN_WIDTH,
    maxLength
  );
  // Each threshold is independently sane once clamped to maxLength, but nothing above stops a
  // caller from passing them in the wrong order relative to each other (e.g. a forceMultilineMinWidth
  // below the default singleLineMaxWidth). Left unchecked, decideBlockShape's first branch
  // (collapsedWidth <= singleLineMaxWidth) would silently win for any width in the resulting
  // inverted gap, quietly ignoring the caller's forceMultilineMinWidth override rather than ever
  // running in a misleading state (this repo's fail-fast convention).
  if (forceMultilineMinWidth < singleLineMaxWidth) {
    throw new Error(
      `forceMultilineMinWidth (${forceMultilineMinWidth}) must be >= singleLineMaxWidth (${singleLineMaxWidth}).`
    );
  }

  const joined = words.join(' ');
  const collapsedWidth =
    comment.indent + measure(comment.open) + 1 + measure(joined) + 1 + measure(comment.close);
  const shape = decideBlockShape(collapsedWidth, currentShape, singleLineMaxWidth, forceMultilineMinWidth);

  return shape === 'single-line' ? `${comment.open} ${joined} ${comment.close}` : undefined;
}

/**
 * Joins a continuation prefix (e.g. `' * '`, or a no-trailing-space `' *'` some files use) to a
 * content line, inserting a space between the two only when the concatenation would otherwise
 * form a real `*​/` sequence and prematurely close the comment. A `prefix` ending in `*` immediately
 * followed by `content` starting with `/` is exactly the shape a comment's own body can contain
 * without incident (e.g. an embedded `// example` line inside a larger explanatory comment, or a
 * `/* nested *​/`-looking mention), right up until this reconstruction glues the two together with
 * nothing in between. This was a real, previously unreachable bug: it only started firing once
 * plan §12 Phase 5 began running every block comment through reconstruction, including ones that
 * already fit and were never touched before, confirmed by the plan §9.3 corpus scan finding it in
 * real `node_modules` content.
 */
function joinPrefixAndContent(prefix: string, content: string): string {
  const needsSeparatingSpace = prefix.endsWith('*') && content.startsWith('/');
  return needsSeparatingSpace ? `${prefix} ${content}` : `${prefix}${content}`;
}

/**
 * `true` for a single physical line `wrap()` itself would never modify: a directive (plan §8.1), a
 * blank line, an unterminated fence or `@example` marker, or table-like content (plan §8.3).
 * Distinguishes "`wrap()` left this untouched because it's protected, so the original must be
 * preserved byte-for-byte" from "`wrap()` left this untouched because it happens to already fit
 * its own budget," which is safe to reconstruct normally even though the text itself didn't
 * change. Delegates to `splitIntoBlocks` itself, the same function `wrap()` uses internally,
 * rather than re-deriving its protection rules here: an earlier version of this helper checked
 * only `checkIsDirective`/`checkIsTableLike` directly and silently missed the fence/`@example`/
 * blank-line cases, which would have reintroduced the exact class of bug this file's other fixes
 * were written to close, just for a different protected-block reason.
 */
function checkIsProtectedLine(line: string, extraDirectives: readonly string[] | undefined): boolean {
  const blocks = splitIntoBlocks([line], extraDirectives ?? []);
  return blocks[0]?.protected ?? false;
}

function checkArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, idx) => line === b[idx]);
}

function stripLinePrefix(line: string, prefix: string): string {
  if (line.startsWith(prefix)) {
    return line.slice(prefix.length);
  }
  // Doesn't match the detected/synthesized prefix exactly (e.g. a line with inconsistent
  // indentation). Fall back to stripping generic leading whitespace and an optional `*` rather
  // than losing the line's content.
  return line.replace(/^\s*\*?\s?/, '');
}
