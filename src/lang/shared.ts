import type {Comment} from './types.ts';

/*
 * Entry.
 */

/**
 * Scans, builds, and computes the pieces of a `Comment` shared by every `/* *​/`-and-`//`-style
 * lexer (`js.ts`, `css.ts`, and any future one): these care only about comment delimiters and
 * surrounding whitespace, never about the source language's own tokens, so a change to how any of
 * this works (e.g. the bounded-star opener convention, or how `indent`/`ownLine` are derived)
 * only ever needs to happen in one place. What's deliberately *not* here is anything a lexer needs
 * to disambiguate comments from language-specific constructs (JS's regex-vs-division tracking,
 * CSS's `url(...)` skipping) — that stays local to each lexer, since it has no shared meaning.
 */
export function buildComment(kind: 'line' | 'block', source: string, start: number, end: number): Comment {
  const closed = kind === 'block' && end - start >= 4 && source.slice(end - 2, end) === '*/';
  const open = kind === 'line' ? '//' : blockOpen(source, start, end, closed);
  return {
    kind,
    open,
    close: closed ? '*/' : '',
    linePrefix: kind === 'block' ? computeLinePrefix(source, start, end) : '',
    start,
    end,
    indent: computeIndent(source, start),
    ownLine: computeOwnLine(source, start)
  };
}

export function scanLineComment(source: string, start: number): number {
  const newline = source.indexOf('\n', start + 2);
  return newline === -1 ? source.length : newline;
}

export function scanBlockComment(source: string, start: number): number {
  const close = source.indexOf('*/', start + 2);
  return close === -1 ? source.length : close + 2;
}

export function scanString(source: string, start: number, quote: string): number {
  const n = source.length;
  let i = start + 1;
  while (i < n) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    if (ch === '\n') {
      return i; // Unterminated string. Stop before the newline rather than consume it.
    }
    i += 1;
  }
  return n;
}

/*
 * Helpers.
 */

/**
 * A block comment's open delimiter is `/*` plus any immediately-following `*` characters (the
 * `/**` JSDoc convention). Extra stars are decoration, not content, so downstream reflow
 * shouldn't see them as body text. Bounded by the close position (or `end`, for an unterminated
 * comment) so this can never consume into or past the closing `*​/` itself: for `/**​/ `
 * (empty body) the close starts right at index 2, so the bound stops the scan there and `open`
 * stays `/*`, not `/**`.
 */
function blockOpen(source: string, start: number, end: number, closed: boolean): string {
  const limit = closed ? end - 2 : end;
  let i = start + 2;
  while (i < limit && source[i] === '*') {
    i += 1;
  }
  return source.slice(start, i);
}

function computeIndent(source: string, start: number): number {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  return start - lineStart;
}

function computeOwnLine(source: string, start: number): boolean {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  return /^\s*$/.test(source.slice(lineStart, start));
}

/**
 * Heuristic hint for `core/`: if a multi-line block comment's second line starts with `<indent>*`
 * (optionally followed by one space), reuse that prefix. Not a guarantee. `src/index.ts`'s
 * `reflowBlockComment` owns the real decision, this just carries forward what the author already
 * wrote.
 */
function computeLinePrefix(source: string, start: number, end: number): string {
  const secondNewline = source.indexOf('\n', start);
  if (secondNewline === -1 || secondNewline >= end) {
    return '';
  }
  const lineEnd = source.indexOf('\n', secondNewline + 1);
  const secondLine = source.slice(secondNewline + 1, lineEnd === -1 ? end : lineEnd);
  const match = /^(\s*\*\s?)/.exec(secondLine);
  return match ? (match[1] as string) : '';
}
