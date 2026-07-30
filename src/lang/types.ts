/*
 * Types.
 */

/** Comment delimiter shape. `line` covers `//`. `block` covers `/*` comments. */
export type CommentKind = 'line' | 'block';

/**
 * Every language `format()` can reflow comments for (plan §4). Defined here, not in `src/index.ts`,
 * so `Comment` below can reference it without a circular import; re-exported from `src/index.ts`
 * for every existing caller.
 */
export type Lang = 'js' | 'css' | 'html' | 'astro';

/**
 * A comment located in source text. Lexers (`lang/*.ts`) produce these. `core/` consumes them and
 * never re-derives anything from raw source, so every field a reflow decision needs must live
 * here.
 */
export type Comment = {
  readonly kind: CommentKind;
  /** Opening delimiter as it appears in source: `//` or a run of `/` and `*` characters. */
  readonly open: string;
  /** Closing delimiter: empty for a line comment, the `*` + `/` pair for a block comment. */
  readonly close: string;
  /**
   * Continuation-line prefix already used in source for a multi-line block comment's non-first
   * lines (e.g. `' * '`). Empty when the comment is single-line or no consistent prefix was
   * detected. A hint for `core/` to preserve JSDoc-style star-prefixing when reflowing.
   */
  readonly linePrefix: string;
  /** Byte offset of the comment's first character (the start of `open`) in source. */
  readonly start: number;
  /**
   * Byte offset one past the comment's last character (the end of `close`, or of the last line
   * for an unterminated block comment).
   */
  readonly end: number;
  /**
   * 0-based column the comment starts at, i.e. how much leading whitespace precedes `open` on
   * its source line. Used to compute the width budget available for reflowed content.
   */
  readonly indent: number;
  /**
   * `true` when nothing but whitespace precedes the comment on its source line (as opposed to
   * trailing a statement, e.g. `const x = 1; // trailing`).
   */
  readonly ownLine: boolean;
  /**
   * Overrides `format()`'s own `options.lang` for this one comment's block-comment style (plan
   * §4). Unset for every comment a lexer finds directly in its own language. Set only by
   * `lang/html.ts` on a comment delegated from a `<script>`/`<style>` body: that comment is
   * genuinely JS or CSS, not HTML, so it should expand using JS/CSS's `* ` star convention, not
   * HTML's plain-indent one, even though the surrounding document's `format()` call is `lang: 'html'`.
   */
  readonly lang?: Lang;
};
