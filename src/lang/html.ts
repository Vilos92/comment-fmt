import {findComments as findCommentsCss} from './css.ts';
import {findComments as findCommentsJs} from './js.ts';
import {buildComment, computeIndent, computeOwnLine} from './shared.ts';
import type {Comment} from './types.ts';

/*
 * Types.
 */

type HtmlCommentSpan = {readonly end: number; readonly closed: boolean};

type TagInfo = {
  readonly end: number;
  readonly name: string;
  readonly isClosing: boolean;
  readonly selfClosing: boolean;
};

/**
 * How each element's content is treated once its opening tag is seen. `'skip'` elements
 * (`<pre>`, `<textarea>`, `<title>`) are never scanned for comments at all, for two different
 * reasons that land on the same handling: `<textarea>`/`<title>` are raw-text elements per the
 * HTML5 spec, so a `<!-- -->`-looking substring inside one is literal data, never a real comment
 * node. `<pre>` content *is* real, parsed markup — a comment inside it is a genuine comment — but
 * its whitespace is rendering-significant, so reflowing one would change what the page displays.
 * `'delegate-js'`/`'delegate-css'` elements (`<script>`, `<style>`) hand their body to the JS/CSS
 * lexer to find real `//`/`/* *​/` comments within, per plan §4.
 */
type OpaqueKind = 'skip' | 'delegate-js' | 'delegate-css';

/*
 * Constants.
 */

const OPEN = '<!--';
const CLOSE = '-->';

const TAG_NAME_START = /[a-zA-Z]/;
const TAG_NAME_PART = /[a-zA-Z0-9-]/;

const OPAQUE_ELEMENTS: ReadonlyMap<string, OpaqueKind> = new Map([
  ['script', 'delegate-js'],
  ['style', 'delegate-css'],
  ['pre', 'skip'],
  ['textarea', 'skip'],
  ['title', 'skip']
]);

/*
 * Entry.
 */

/**
 * Locates every `<!-- ... -->` comment in HTML source, skipping quoted attribute values (so
 * `<a href="<!-- not a comment -->">` isn't mistaken for one), never reporting a comment inside a
 * raw-text element (`<textarea>`, `<title>`, and `<script>`/`<style>`'s own delimiter-recognition
 * once their body is delegated) or inside `<pre>` (real comments, but never touched -- see
 * `OpaqueKind`), and delegating `<script>`/`<style>` bodies to `js.ts`/`css.ts` with their offsets
 * remapped from the extracted substring back onto this document (plan §4).
 *
 * `start`/`end` bound the scan to a region of `source` without changing what `source` itself
 * means: every offset computation (`indent`, `ownLine`, and any nested `<script>`/`<style>`
 * delegation) still runs against the real, full document. `lang/astro.ts` relies on this to scan
 * just an `.astro` file's template portion (everything after its frontmatter fence) while a
 * comment on the same source line as content before that region -- impossible in practice since
 * the fence is always its own line, but not a fact this function should have to assume -- would
 * still compute the right `indent`. Defaults to the whole string, so every other caller is unaffected.
 *
 * No parser is used, mirroring `lang/js.ts` and `lang/css.ts`. This is a single forward character
 * scan, with just enough tag recognition (name, closing/self-closing, quoted-attribute skipping)
 * to know when to stop looking for comments and delegate or skip instead.
 */
export function findComments(source: string, start = 0, end = source.length): Comment[] {
  const comments: Comment[] = [];
  const n = end;
  let i = start;

  while (i < n) {
    if (source.startsWith(OPEN, i)) {
      const span = scanHtmlComment(source, i);
      comments.push(buildHtmlComment(source, i, span));
      i = span.end;
      continue;
    }

    if (source[i] !== '<') {
      i += 1;
      continue;
    }

    const tag = scanTag(source, i);
    if (!tag) {
      i += 1; // Not a real tag (e.g. a bare `<` in text). Treat it as an ordinary character.
      continue;
    }

    if (!tag.isClosing && !tag.selfClosing) {
      const opaque = OPAQUE_ELEMENTS.get(tag.name);
      if (opaque) {
        const bodyEnd = findRawTextEnd(source, tag.end, tag.name);
        if (opaque !== 'skip') {
          comments.push(...delegateComments(source, tag.end, bodyEnd, opaque));
        }
        i = bodyEnd; // Stop right before the closing tag; the next loop iteration scans it normally.
        continue;
      }
    }

    i = tag.end;
  }

  return comments;
}

/*
 * Helpers.
 */

/**
 * Scans an HTML comment positioned on `<!--`. Handles the two WHATWG-defined degenerate short
 * forms first -- `<!-->` and `<!--->` are each a complete, *empty*-content comment by spec (the
 * "comment start"/"comment start dash" tokenizer states both treat an immediately-following `>`
 * as a parse error that still closes the comment), not a comment still looking for its close.
 * Getting this wrong would search onward for the *next* real `-->` in the document and swallow
 * everything up to it as one comment -- a genuine corruption bug, not just a cosmetic one.
 */
function scanHtmlComment(source: string, start: number): HtmlCommentSpan {
  if (source[start + 4] === '>') {
    return {end: start + 5, closed: true};
  }
  if (source[start + 4] === '-' && source[start + 5] === '>') {
    return {end: start + 6, closed: true};
  }
  const closeIdx = source.indexOf(CLOSE, start + 4);
  return closeIdx === -1 ? {end: source.length, closed: false} : {end: closeIdx + CLOSE.length, closed: true};
}

function buildHtmlComment(source: string, start: number, span: HtmlCommentSpan): Comment {
  // A degenerate short form's `open` and `close` would overlap (5-6 total chars, but `OPEN.length
  // + CLOSE.length` is 7) -- there's no room for real content either way, so the whole span is
  // represented as `open` with an empty `close` rather than slicing negative-length content.
  const isDegenerateShortForm = span.closed && span.end - start < OPEN.length + CLOSE.length;
  const open = isDegenerateShortForm ? source.slice(start, span.end) : OPEN;
  let close = '';
  if (!isDegenerateShortForm && span.closed) {
    close = CLOSE;
  }
  return {
    kind: 'block',
    open,
    close,
    // Unlike JS/CSS's `* ` JSDoc convention, HTML has no established per-line decoration for a
    // multi-line comment's continuation lines, so there's no author convention worth detecting
    // here -- `src/index.ts`'s per-language style plugs in a plain-indent default instead.
    linePrefix: '',
    start,
    end: span.end,
    indent: computeIndent(source, start),
    ownLine: computeOwnLine(source, start)
  };
}

/**
 * Scans a tag positioned on `<`, skipping quoted attribute values as opaque spans (HTML attribute
 * values have no backslash-escape syntax, unlike a JS/CSS string, so a literal `\` inside one has
 * no special meaning and must not be treated as escaping the following character). Returns
 * `undefined` for something that isn't actually a tag (a bare `<` in text) or an unterminated one
 * at EOF, so the caller can fall back to treating `<` as an ordinary character.
 */
function scanTag(source: string, start: number): TagInfo | undefined {
  const n = source.length;
  let i = start + 1;
  const isClosing = source[i] === '/';
  if (isClosing) {
    i += 1;
  }

  if (!TAG_NAME_START.test(source[i] ?? '')) {
    return undefined;
  }

  const nameStart = i;
  while (i < n && TAG_NAME_PART.test(source[i] as string)) {
    i += 1;
  }
  const name = source.slice(nameStart, i).toLowerCase();

  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = scanAttributeValue(source, i, ch);
      continue;
    }
    if (ch === '>') {
      return {end: i + 1, name, isClosing, selfClosing: source[i - 1] === '/'};
    }
    i += 1;
  }

  return undefined;
}

function scanAttributeValue(source: string, start: number, quote: string): number {
  const closeIdx = source.indexOf(quote, start + 1);
  return closeIdx === -1 ? source.length : closeIdx + 1;
}

/**
 * Finds where `tagName`'s raw-text body ends: the start of its first case-insensitive literal
 * `</tagName` closing tag. Real HTML raw-text parsing (script/style/textarea/title) works exactly
 * this way -- looking for the literal end tag text, not recursively parsing the body as markup --
 * so this deliberately doesn't track nesting depth; a `<script>` string containing the text
 * `</script` would only confuse a real browser too. `<pre>` reuses this same literal-search
 * approach as a deliberate simplification (real `<pre>` content is normal nested markup, but
 * nothing inside it is ever reflowed regardless, so exact nesting fidelity buys nothing here).
 * Returns `source.length` if no closing tag is found, accepting the rest of the file as the body
 * rather than looping or crashing on truncated input.
 */
function findRawTextEnd(source: string, bodyStart: number, tagName: string): number {
  const n = source.length;
  const closingTag = `</${tagName}`;
  let i = bodyStart;
  while (i < n) {
    if (source.slice(i, i + closingTag.length).toLowerCase() === closingTag) {
      const afterName = source[i + closingTag.length];
      if (afterName === undefined || afterName === '>' || /\s/.test(afterName)) {
        return i;
      }
    }
    i += 1;
  }
  return n;
}

/**
 * Delegates a `<script>`/`<style>` body to `js.ts`/`css.ts`, then remaps each found comment's
 * offsets from the extracted substring back onto the full document and re-derives it via the
 * shared `buildComment` (plan §4's "position-offsetting, not a simple call-through"). Re-deriving
 * from the real document -- rather than just shifting the nested lexer's own `indent`/`ownLine`/
 * `linePrefix` -- matters whenever a comment sits on the same source line as content before the
 * delegated region starts (e.g. `<script>const x = 1; // c</script>`), which the substring alone
 * has no way to see.
 */
function delegateComments(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  kind: 'delegate-js' | 'delegate-css'
): Comment[] {
  const lang = kind === 'delegate-js' ? 'js' : 'css';
  const body = source.slice(bodyStart, bodyEnd);
  const nested = lang === 'js' ? findCommentsJs(body) : findCommentsCss(body);
  return nested.map(comment => ({
    // `lang` overrides `format()`'s own `options.lang` (`'html'`) for this one comment: it's
    // genuinely JS or CSS, so it should expand using that language's `* ` star convention, not
    // HTML's plain-indent one, if it needs to grow from single-line to multi-line (plan §4).
    ...buildComment(comment.kind, source, comment.start + bodyStart, comment.end + bodyStart),
    lang
  }));
}
