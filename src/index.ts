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

// Default continuation-line prefix for a block comment being expanded from single-line to
// multi-line shape, where there's no existing second line to detect a convention from. Aligns
// the `*` one column right of the comment's own `/`, matching common JSDoc style.
const DEFAULT_BLOCK_PREFIX = '* ';

/*
 * Script.
 */

/**
 * Reflows every `//` and `/* *​/` comment in JS/TS/JSX/TSX source text to fit within
 * `options.maxLength` columns, without touching anything else -- non-comment code is guaranteed
 * byte-for-byte identical (see `test/props`, property 9.1.4).
 *
 * A comment whose every physical line already fits is returned completely untouched, not just
 * "unchanged content re-serialized the same way" -- this function slices the original source
 * around comments it doesn't need to touch, rather than reconstructing them, so there's no path
 * by which reflow logic could introduce a whitespace difference in already-fitting content.
 */
export function format(source: string, options: FormatOptions = {}): string {
  const comments = findComments(source);
  let result = source;

  // Reverse order: replacing a later comment first keeps every earlier comment's [start, end)
  // offsets -- computed against the original `source` -- valid against `result` at each step.
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i] as Comment;
    const replacement = reflowComment(source, comment, options);
    result = result.slice(0, comment.start) + replacement + result.slice(comment.end);
  }

  return result;
}

/*
 * Helpers.
 */

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

function reflowBlockComment(comment: Comment, raw: string, options: FormatOptions): string {
  const terminated = comment.close.length > 0;
  // When terminated, `inner` spans from right after `open` to right before the closing `*/`, so
  // for a multi-line comment its last split-by-`\n` entry isn't a content line at all -- it's
  // whatever whitespace sits on the closer's own physical line before `*/` (e.g. the ` ` in
  // `\n */`). Folding that into content, as an earlier version of this function did, both
  // double-counts it as a blank content line and throws away the closer's real indentation. An
  // unterminated comment (malformed/truncated source, `comment.close === ''`) has no such line at
  // all -- every physical line is real content, and there's no closer to reconstruct.
  const inner = terminated
    ? raw.slice(comment.open.length, raw.length - comment.close.length)
    : raw.slice(comment.open.length);
  const physicalLines = inner.split('\n');
  const wasSingleLine = physicalLines.length === 1;

  // A comment already spanning multiple physical lines carries its own detected `linePrefix`
  // (full leading whitespace already included, per `computeLinePrefix` in lang/js.ts). One that's
  // only overflowing now, and must expand from single-line, has no such line to detect a
  // convention from -- synthesize one aligned under the comment's second character (DEFAULT_BLOCK_PREFIX).
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
  // `comment.indent + comment.open.length`, not `continuationPrefix`'s -- they're equal for
  // aligned JSDoc-style comments (`/**` is 3 columns, ` * ` is 3 columns) but diverge for e.g. a
  // `/***`-opened comment (4 columns) against a synthesized ` * ` continuation (3 columns).
  // wrap() takes one uniform budget for the whole call, so use whichever of the two is larger:
  // never smaller than line 0 needs (so it can't push line 0 over maxLength), and continuation
  // lines wrap very slightly earlier than strictly required in the rare case they diverge -- safe
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
  // indentation) -- fall back to stripping generic leading whitespace and an optional `*` rather
  // than losing the line's content.
  return line.replace(/^\s*\*?\s?/, '');
}
