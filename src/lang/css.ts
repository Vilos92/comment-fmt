import {buildComment, scanBlockComment, scanLineComment, scanString} from './shared.ts';
import type {Comment} from './types.ts';

/*
 * Constants.
 */

const IDENTIFIER_PART = /[\p{L}\p{N}_-]/u;

/**
 * A CSS escape expands to at most one logical character: `\` plus up to 6 hex digits plus one
 * optional trailing whitespace character. `url` is 3 logical characters, so no escaped spelling of
 * it can span more raw source than 3 of these.
 */
const MAX_URL_IDENT_RAW_LENGTH = 8 * 3;

/*
 * Entry.
 */

/**
 * Locates every `/* ... *​/` and SCSS `//` comment in CSS/SCSS source, skipping string literals and
 * unquoted `url(...)` contents so their contents are never mistaken for comment delimiters.
 *
 * `//` is recognized unconditionally, regardless of whether the file is `.css` or `.scss`. A bare `//`
 * is never valid, meaningful CSS syntax outside a string or `url()`, so there's no ambiguity cost to
 * treating it the same way in both extensions.
 *
 * No parser is used, mirroring `lang/js.ts`. This is a single forward character scan that only tracks
 * enough state to recognize string boundaries and the unquoted `url(...)` span as opaque, uninterpreted
 * text.
 */
export function findComments(source: string): Comment[] {
  const comments: Comment[] = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const ch = source[i] as string;

    if (ch === '/' && source[i + 1] === '*') {
      const end = scanBlockComment(source, i);
      comments.push(buildComment('block', source, i, end));
      i = end;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      const end = scanLineComment(source, i);
      comments.push(buildComment('line', source, i, end));
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'") {
      i = scanString(source, i, ch);
      continue;
    }

    if (checkIsUnquotedUrlStart(source, i)) {
      i = scanUnquotedUrl(source, i);
      continue;
    }

    i += 1;
  }

  return comments;
}

/*
 * Helpers.
 */

/**
 * Detects the start of an unquoted `url(` value at index `i` (positioned on the `(`), matching `url`
 * case-insensitively per CSS's case-insensitive function-name rule. Requires a non-identifier
 * character (or start of source) immediately before `url` so a longer name ending in `url`, like a
 * hypothetical `my-url(...)`, isn't mistaken for the function. Only the unquoted form needs this
 * special case: `url("...")`/`url('...')` are already handled correctly by `scanString`, since
 * whatever precedes a quote is irrelevant to string-skipping.
 *
 * Also recognizes `url` spelled with CSS identifier escapes (e.g. `u\72l(`, a real, spec-legal
 * spelling, not a hypothetical one). Skipping this would leave `//` inside an escaped-spelling
 * `url(...)`'s payload misdetected as an SCSS line comment, corrupting the payload the moment
 * reflow touches it (confirmed: a base64 data URL's bytes get a stray space spliced in).
 */
function checkIsUnquotedUrlStart(source: string, i: number): boolean {
  if (source[i] !== '(') {
    return false;
  }
  const identStart = findUrlIdentStart(source, i);
  if (identStart === undefined) {
    return false;
  }
  const before = source[identStart - 1];
  if (before !== undefined && IDENTIFIER_PART.test(before)) {
    return false;
  }
  const next = source[i + 1];
  return next !== '"' && next !== "'";
}

/**
 * Finds the start of a `url` identifier ending exactly at `identEnd` (the position of its `(`), or
 * `undefined` if none is there. Checks the plain literal spelling first, since that's every ordinary
 * `url(...)` in practice, and only falls back to decoding CSS identifier escapes (rare, and
 * expensive relative to a 3-character slice comparison) when that fails.
 */
function findUrlIdentStart(source: string, identEnd: number): number | undefined {
  if (source.slice(identEnd - 3, identEnd).toLowerCase() === 'url') {
    return identEnd - 3;
  }
  const windowStart = Math.max(0, identEnd - MAX_URL_IDENT_RAW_LENGTH);
  for (let start = identEnd - 1; start >= windowStart; start -= 1) {
    if (decodeCssIdentEscapes(source, start, identEnd)?.toLowerCase() === 'url') {
      return start;
    }
  }
  return undefined;
}

/**
 * Decodes CSS identifier escapes in `source.slice(start, end)`: `\` plus 1-6 hex digits (plus one
 * optional trailing whitespace character that terminates the escape without itself being decoded),
 * or `\` plus any other single non-newline character taken literally. Returns `undefined` for a
 * dangling `\` at `end` or one immediately followed by a newline, since neither is a valid escape.
 * Only meant to recognize a handful of known short keywords (`url`) written this way, not to
 * tokenize CSS identifiers in general.
 */
function decodeCssIdentEscapes(source: string, start: number, end: number): string | undefined {
  let result = '';
  let i = start;
  while (i < end) {
    const ch = source[i] as string;
    if (ch !== '\\') {
      result += ch;
      i += 1;
      continue;
    }
    i += 1;
    if (i >= end || source[i] === '\n') {
      return undefined;
    }
    const hexMatch = /^[0-9a-fA-F]{1,6}/.exec(source.slice(i, end));
    if (!hexMatch) {
      result += source[i];
      i += 1;
      continue;
    }
    result += String.fromCodePoint(Number.parseInt(hexMatch[0], 16));
    i += hexMatch[0].length;
    if (i < end && /[ \t\n\f]/.test(source[i] as string)) {
      i += 1; // One trailing whitespace character terminates the hex escape, per spec.
    }
  }
  return result;
}

/**
 * Skips an unquoted `url(...)` value as one opaque span, positioned at its opening `(`. The content
 * runs until the matching unescaped `)` and is never scanned for comment delimiters, so a `//` inside
 * a data URL (a base64 payload can contain one by chance) is never mistaken for a comment start.
 */
function scanUnquotedUrl(source: string, start: number): number {
  const n = source.length;
  let i = start + 1;
  while (i < n) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === ')') {
      return i + 1;
    }
    i += 1;
  }
  return n; // Unterminated at EOF. Accept what we scanned rather than loop or crash.
}
