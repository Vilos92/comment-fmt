import {buildComment, scanBlockComment, scanLineComment, scanString} from './shared.ts';
import type {Comment} from './types.ts';

// comment-fmt-ignore
/*
 * Constants.
 */

const IDENTIFIER_PART = /[\p{L}\p{N}_-]/u;

// comment-fmt-ignore
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

// comment-fmt-ignore
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
 */
function checkIsUnquotedUrlStart(source: string, i: number): boolean {
  if (source[i] !== '(') {
    return false;
  }
  if (source.slice(i - 3, i).toLowerCase() !== 'url') {
    return false;
  }
  const before = source[i - 4];
  if (before !== undefined && IDENTIFIER_PART.test(before)) {
    return false;
  }
  const next = source[i + 1];
  return next !== '"' && next !== "'";
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
