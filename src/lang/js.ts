// comment-fmt-ignore
/*
 * Types.
 */

import {buildComment, scanBlockComment, scanLineComment, scanString} from './shared.ts';
import type {Comment} from './types.ts';

/**
 * Coarse classification of the most recently scanned token, used only to decide whether a bare
 * `/` starts a regex literal or is a division operator. `'value'` means the previous token was
 * something a `/` after it would divide (an identifier, literal, or closing `)`/`]`/postfix
 * `++`/`--`). Anything else (operators, most keywords, start of file/expression) is
 * `'expr-start'`. A `/` there begins a regex.
 */
type TokenCategory = 'value' | 'expr-start';

/**
 * One frame of the template-literal stack. `'text'` means we're scanning raw template characters
 * looking for `` ` ``, `\`, or `${`. `'expr'` means we're inside a `${...}` interpolation, doing
 * normal token scanning with `braceDepth` tracking nested `{}` so the interpolation's own closing
 * `}` isn't mistaken for an unrelated brace.
 */
type TemplateFrame = {readonly kind: 'text'} | {readonly kind: 'expr'; braceDepth: number};

// comment-fmt-ignore
/*
 * Constants.
 */

/**
 * Words after which a `/` starts an expression (regex), not a division. Deliberately limited to
 * words that are *always* reserved (never legal as a plain identifier or property name) in
 * strict-mode/module code, which every JS/TS/JSX/TSX file this tool targets is. Contextual
 * keywords (`async`, `get`, `set`, `of`, `as`, `from`, `type`, `satisfies`, `is`, `override`,
 * etc.) are NOT here even though they're keyword-shaped, because they're also completely legal
 * identifiers (`const async = 1; async / 2` is real, valid code). Including them caused a
 * confirmed bug where `x = async / 2; // real` swallowed the trailing comment as fake regex
 * content, since `async` isn't actually a value-position word here, it's a variable name.
 * Everything NOT in this set (plain identifiers, `this`/`super`/`true`/`false`/`null`, and any
 * contextual keyword used as a value) defaults to value-like (division). Erring toward regex on
 * an unlisted word is the safer failure mode. A wrongly-assumed regex that finds no valid close
 * falls back to division (see `scanRegex`). A wrongly-assumed division would scan a real regex
 * literal as ordinary code, and a `//` or `/*` inside its body would then corrupt the parse.
 */
const EXPR_START_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'extends',
  'default',
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'with',
  'function',
  'class',
  'const',
  'let',
  'var',
  'import',
  'export',
  'enum',
  'interface',
  'implements',
  'public',
  'private',
  'protected'
]);

/** Postfix operators: the expression before them is already complete, so a following `/` divides. */
const POSTFIX_OPERATORS = new Set(['++', '--']);

/**
 * `)` and `]` close a value expression (a call/parenthesized expression, an index/array), so a
 * following `/` divides. `}` is deliberately absent: at top level it's ambiguous between closing
 * a block statement (regex should follow) and closing an object literal (division should
 * follow), and resolving that needs real parsing. It defaults to `'expr-start'` via the generic
 * fallback below, for the same erring-toward-regex reasoning as `EXPR_START_KEYWORDS`. Inside a
 * template `${...}`, `}` is handled separately by brace-depth tracking instead (see
 * `TemplateFrame`), where the object-vs-interpolation question is already resolved by depth.
 */
const VALUE_CLOSERS = new Set([')', ']']);

const IDENTIFIER_START = /[\p{L}\p{Nl}_$]/u;
const IDENTIFIER_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]/u;
const DIGIT = /[0-9]/;
const DECIMAL_DIGIT = /[0-9_]/;
const FLAG_LETTER = /[a-zA-Z]/;

const RADIX_DIGIT_BY_PREFIX = new Map([
  ['0x', /[0-9a-fA-F_]/],
  ['0o', /[0-7_]/],
  ['0b', /[01_]/]
]);

// comment-fmt-ignore
/*
 * Entry.
 */

/**
 * Locates every `//` and `/* ... *​/`-style comment in JS/TS/JSX/TSX source, skipping string,
 * template, and regex literals so their contents are never mistaken for comment delimiters.
 *
 * Deliberately unsupported, by design rather than oversight:
 * - Legacy Annex B `<!--`/`-->` line comments (sloppy-mode only, and would collide with `<` as a
 *   comparison operator or a JSX tag open, so it's not worth the ambiguity for a construct that's dead
 *   in modern TS/JSX).
 * - JSX text-node content is not tracked, so `//` or `/* *​/` inside JSX children text (not inside
 *   a `{...}` expression container) is misread as a real comment. Fixing this needs real
 *   JSX-tag-vs-text-mode tracking, which is parser territory. Comments inside `{/* like this *​/}`
 *   work fine today since `{`/`}` are ordinary punctuation to this scanner.
 *
 * No parser is used. This is a single forward character scan that tracks just enough token
 * context (the previous token's value-vs-expression-start category, and a template-literal
 * nesting stack) to disambiguate regex literals from division and to find comments nested inside
 * `${...}` interpolations, including nested templates.
 */
export function findComments(source: string): Comment[] {
  const comments: Comment[] = [];
  const n = source.length;
  const templateStack: TemplateFrame[] = [];
  let lastCategory: TokenCategory = 'expr-start';
  // Property names can be any identifier, including a word in `EXPR_START_KEYWORDS`. For example,
  // `x.return / 2` is valid, unambiguous division. Without this, a member access on a
  // reserved-word-shaped property name would misclassify the following `/` as a regex start.
  let afterDot = false;
  let i = source.startsWith('#!') ? skipHashbang(source) : 0;

  while (i < n) {
    const frame = templateStack[templateStack.length - 1];

    if (frame?.kind === 'text') {
      i = stepTemplateText(source, i, templateStack);
      continue;
    }

    const ch = source[i] as string;

    if (checkIsWhitespace(ch)) {
      i += 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      const end = scanLineComment(source, i);
      comments.push(buildComment('line', source, i, end));
      i = end;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const end = scanBlockComment(source, i);
      comments.push(buildComment('block', source, i, end));
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'") {
      i = scanString(source, i, ch);
      lastCategory = 'value';
      afterDot = false;
      continue;
    }

    if (ch === '`') {
      templateStack.push({kind: 'text'});
      i += 1;
      afterDot = false;
      continue;
    }

    if (ch === '/' && lastCategory === 'expr-start') {
      const end = scanRegex(source, i);
      if (end !== undefined) {
        i = end;
        lastCategory = 'value';
        afterDot = false;
        continue;
      }
      // Not a valid regex on this line (see `scanRegex`). Fall through to generic handling below,
      // which treats the '/' as a division/operator punctuator.
    }

    if (ch === '#' ? IDENTIFIER_START.test(source[i + 1] ?? '') : IDENTIFIER_START.test(ch)) {
      const {end, text} = scanIdentifier(source, i);
      lastCategory = afterDot || !EXPR_START_KEYWORDS.has(text) ? 'value' : 'expr-start';
      afterDot = false;
      i = end;
      continue;
    }

    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(source[i + 1] ?? ''))) {
      i = scanNumber(source, i);
      lastCategory = 'value';
      afterDot = false;
      continue;
    }

    if (frame?.kind === 'expr' && (ch === '{' || ch === '}')) {
      i = stepTemplateExprBrace(ch, frame, templateStack, i);
      lastCategory = 'value';
      afterDot = false;
      continue;
    }

    const step = stepGenericToken(source, i);
    i = step.end;
    lastCategory = step.category;
    afterDot = ch === '.';
  }

  return comments;
}

// comment-fmt-ignore
/*
 * Helpers.
 */

function checkIsWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

function skipHashbang(source: string): number {
  const newline = source.indexOf('\n');
  return newline === -1 ? source.length : newline + 1;
}

/**
 * Returns the index one past a regex literal's closing `/` (plus flags), or `undefined` if the
 * span starting at `start` isn't a valid regex literal (hit a newline before an unescaped close,
 * meaning it wasn't one, since JS regex literals can't contain a raw newline).
 */
function scanRegex(source: string, start: number): number | undefined {
  const n = source.length;
  let i = start + 1;
  let inCharClass = false;
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') {
      return undefined;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      i += 1;
      continue;
    }
    if (ch === ']') {
      inCharClass = false;
      i += 1;
      continue;
    }
    if (ch === '/' && !inCharClass) {
      i += 1;
      while (i < n && FLAG_LETTER.test(source[i] as string)) {
        i += 1;
      }
      return i;
    }
    i += 1;
  }
  return n; // Unterminated at EOF. Accept what we scanned rather than loop or crash.
}

function scanIdentifier(source: string, start: number): {end: number; text: string} {
  let i = source[start] === '#' ? start + 1 : start;
  i += 1; // The identifier-start character itself (already validated by the caller).
  while (i < source.length && IDENTIFIER_PART.test(source[i] as string)) {
    i += 1;
  }
  return {end: i, text: source.slice(start, i)};
}

function scanNumber(source: string, start: number): number {
  const n = source.length;
  let i = start;

  const radixPrefix = source.slice(i, i + 2).toLowerCase();
  const radixDigit = RADIX_DIGIT_BY_PREFIX.get(radixPrefix);
  if (radixDigit) {
    i += 2;
    while (i < n && radixDigit.test(source[i] as string)) {
      i += 1;
    }
    return consumeBigIntSuffix(source, i);
  }

  while (i < n && DECIMAL_DIGIT.test(source[i] as string)) {
    i += 1;
  }
  if (source[i] === '.') {
    i += 1;
    while (i < n && DECIMAL_DIGIT.test(source[i] as string)) {
      i += 1;
    }
  }
  if (source[i] === 'e' || source[i] === 'E') {
    let j = i + 1;
    if (source[j] === '+' || source[j] === '-') {
      j += 1;
    }
    if (DIGIT.test(source[j] ?? '')) {
      i = j;
      while (i < n && DECIMAL_DIGIT.test(source[i] as string)) {
        i += 1;
      }
    }
  }
  return consumeBigIntSuffix(source, i);
}

function consumeBigIntSuffix(source: string, i: number): number {
  return source[i] === 'n' ? i + 1 : i;
}

/**
 * Steps one character of raw template text: `\` escapes, `` ` `` closes the template, `${`
 * opens an interpolation (pushes an `'expr'` frame), anything else is ordinary text.
 */
function stepTemplateText(source: string, i: number, templateStack: TemplateFrame[]): number {
  const ch = source[i];
  if (ch === '\\') {
    return i + 2;
  }
  if (ch === '`') {
    templateStack.pop();
    return i + 1;
  }
  if (ch === '$' && source[i + 1] === '{') {
    templateStack.push({kind: 'expr', braceDepth: 0});
    return i + 2;
  }
  return i + 1;
}

/**
 * Steps a `{` or `}` while inside a template's `${...}` interpolation: nested `{}` (e.g. an
 * object literal) is depth-tracked so only the interpolation's own matching `}` pops back to the
 * enclosing template text.
 */
function stepTemplateExprBrace(
  ch: string,
  frame: {kind: 'expr'; braceDepth: number},
  templateStack: TemplateFrame[],
  i: number
): number {
  if (ch === '{') {
    frame.braceDepth += 1;
    return i + 1;
  }
  if (frame.braceDepth === 0) {
    templateStack.pop(); // This '}' closes the interpolation, not a nested object/block.
    return i + 1;
  }
  frame.braceDepth -= 1;
  return i + 1;
}

/**
 * Steps one punctuator/operator character not already handled by a more specific branch above.
 * Only `POSTFIX_OPERATORS` and `VALUE_CLOSERS` produce `'value'`; everything else defaults to
 * `'expr-start'`, the same erring-toward-regex fallback as `EXPR_START_KEYWORDS`.
 */
function stepGenericToken(source: string, i: number): {end: number; category: TokenCategory} {
  const twoChar = source.slice(i, i + 2);
  if (POSTFIX_OPERATORS.has(twoChar)) {
    return {end: i + 2, category: 'value'};
  }
  const ch = source[i] as string;
  if (VALUE_CLOSERS.has(ch)) {
    return {end: i + 1, category: 'value'};
  }
  return {end: i + 1, category: 'expr-start'};
}
