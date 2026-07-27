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
  const indentStr = ' '.repeat(comment.indent);

  return wrapped
    .map((line, idx) => {
      const rendered = line.length > 0 ? `${comment.open} ${line}` : comment.open;
      return idx === 0 ? rendered : `${indentStr}${rendered}`;
    })
    .join('\n');
}

/**
 * Reflows a block comment (`/*`- or `/**`-opened) by extracting its content lines, wrapping them
 * with `wrap()`, and reassembling the delimiters and continuation prefix around the result.
 * Handles both an already multi-line comment (reusing its detected `linePrefix`) and one
 * expanding from single-line for the first time (synthesizing one via `DEFAULT_BLOCK_PREFIX`),
 * and both a properly terminated comment and an unterminated one (malformed/truncated source,
 * which has no closing delimiter to reconstruct).
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
  const contentLines = contentPhysicalLines.map((line, idx) =>
    idx === 0 ? line.replace(/^[ \t]+/, '') : stripLinePrefix(line, continuationPrefix)
  );
  // Line 0 sits right after `open` on the same physical line, so its real prefix width is
  // `comment.indent + comment.open.length`, not `continuationPrefix`'s. They're equal for
  // aligned JSDoc-style comments (`/**` is 3 columns, ` * ` is 3 columns) but diverge for e.g. a
  // `/***`-opened comment (4 columns) against a synthesized ` * ` continuation (3 columns).
  // `wrap()` takes one uniform budget for the whole call, so use whichever of the two is larger:
  // never smaller than line 0 needs (so it can't push line 0 over maxLength), and continuation
  // lines wrap very slightly earlier than strictly required in the rare case they diverge. This is safe
  // in both directions.
  const openWidth = comment.indent + comment.open.length;
  const budget = Math.max(measure(continuationPrefix), openWidth);
  const wrapped = wrap(contentLines, budget, options);

  const first = wrapped[0] ?? '';
  const rest = wrapped.slice(1).map(line => `${continuationPrefix}${line}`.trimEnd());
  const opener = first.length > 0 ? `${comment.open}${first}` : comment.open;
  const lines = terminated ? [opener, ...rest, `${closePrefix}${comment.close}`] : [opener, ...rest];

  return lines.join('\n');
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
