import {splitIntoBlocks} from './core/blocks.ts';
import {DEFAULT_MAX_LENGTH} from './core/constants.ts';
import {measure} from './core/measure.ts';
import {wrap, type WrapOptions} from './core/wrap.ts';
import {findComments} from './lang/js.ts';
import type {Comment} from './lang/types.ts';

/*
 * Types.
 */

export type FormatOptions = WrapOptions;

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

/*
 * Entry.
 */

/**
 * Reflows every `//` and `/* *​/` comment in JS/TS/JSX/TSX source text to fit within
 * `options.maxLength` columns, without touching anything else. Non-comment code is guaranteed
 * byte-for-byte identical (see `test/props`, property 9.1.4).
 *
 * A comment whose every physical line already fits is returned completely untouched, not just
 * "unchanged content re-serialized the same way." This function slices the original source
 * around comments it doesn't need to touch, rather than reconstructing them, so there's no path
 * by which reflow logic could introduce a whitespace difference in already-fitting content. The
 * same applies, unconditionally, to any comment covered by the plan §8.4 escape hatch below.
 */
export function format(source: string, options: FormatOptions = {}): string {
  const comments = findComments(source);
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

  // Block shape (plan §1) is a one-way ratchet driven only by overflow, the same as width
  // already is: a comment expands from single-line to the starred multi-line form when it
  // overflows, but a multi-line comment that already fits is never collapsed back down, no
  // matter how short its content is. That makes "every physical line already fits" the whole
  // answer for both comment kinds, so both share this one short-circuit. Whatever shape a human
  // (or an agent) deliberately chose is left alone as long as it fits; the tool only ever rescues
  // overflow, it doesn't have opinions about a comment being "more compact than it needs to be."
  if (fitsWithinLimit(raw, comment.indent, maxLength)) {
    return raw;
  }

  return comment.kind === 'line'
    ? reflowLineComment(comment, raw, options)
    : reflowBlockComment(comment, raw, options);
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
 * Reflows a block comment (`/*`- or `/**`-opened). Block shape (plan §1) is a one-way ratchet:
 * this function is only ever reached when something overflows (see the shared short-circuit in
 * `reflowComment`), so there is no "should this collapse" decision to make here at all, only "does
 * this need to expand or rewrap." A comment that was already single-line expands to the multi-line
 * starred form; one that was already multi-line stays multi-line and gets its content rewrapped in
 * place, never collapsed back down even if the rewrapped content would technically fit on one
 * line. The opening and closing lines never carry content, per plan §1: every content line,
 * including what would once have been "line 0" right after `open`, gets its own line with
 * `continuationPrefix` applied, exactly like every other content line. Handles both an already
 * multi-line comment (reusing its detected `linePrefix`) and one expanding from single-line for
 * the first time (synthesizing one via `DEFAULT_BLOCK_PREFIX`), and both a properly terminated
 * comment and an unterminated one (malformed/truncated source, which has no closing delimiter to
 * reconstruct).
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
  // deliberate blank-line paragraph break the way one further down would be. Left in, `wrap()`'s
  // own internal block-splitting reads it as its own separate blank-line block, which leaks a
  // spurious blank continuation line into the reconstruction below. Dropping it here is safe:
  // `wrap()` pools every content line's words and re-splits them regardless of original line
  // boundaries, so this placeholder carries no information a real blank line elsewhere in the
  // body doesn't already carry on its own.
  const contentLines =
    !wasSingleLine && rawContentLines.length > 1 && rawContentLines[0] === ''
      ? rawContentLines.slice(1)
      : rawContentLines;
  const extraDirectives = options.extraDirectives ?? [];

  // Every content line now shares one budget: `continuationPrefix`'s width. Nothing is ever
  // attached to `open` any more, so there's no separate, wider budget line 0 alone would have
  // needed under the old opener-attaches-content design.
  const wrapped = wrap(contentLines, measure(continuationPrefix), options);
  if (
    wrapped.length === 1 &&
    wrapped[0] === contentLines[0] &&
    checkIsProtectedLine(contentLines[0] ?? '', extraDirectives)
  ) {
    // `wrap()` left this untouched specifically because it's protected (plan §8.1/§8.3), not
    // merely because it already fits its own budget. Reconstructing below would lose the
    // comment's original leading whitespace even though a protected directive must be preserved
    // byte-for-byte. Return the untouched original instead.
    return raw;
  }

  const rest = wrapped.map(line => joinPrefixAndContent(continuationPrefix, line).trimEnd());
  const lines = terminated
    ? [comment.open, ...rest, `${closePrefix}${comment.close}`]
    : [comment.open, ...rest];

  return lines.join('\n');
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

function stripLinePrefix(line: string, prefix: string): string {
  if (line.startsWith(prefix)) {
    return line.slice(prefix.length);
  }
  // Doesn't match the detected/synthesized prefix exactly (e.g. a line with inconsistent
  // indentation). Fall back to stripping generic leading whitespace and an optional `*` rather
  // than losing the line's content.
  return line.replace(/^\s*\*?\s?/, '');
}
