import {findComments as findCommentsHtml} from './html.ts';
import {findComments as findCommentsJs} from './js.ts';
import {buildComment} from './shared.ts';
import type {Comment} from './types.ts';

/*
 * Types.
 */

type Frontmatter = {
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly templateStart: number;
};

/*
 * Constants.
 */

const FENCE = '---';

/*
 * Entry.
 */

/**
 * Locates every comment in an `.astro` file: frontmatter (TS between `---` fences, delegated to
 * `js.ts`) followed by HTML-like template markup (delegated to `html.ts`), per plan §4's
 * architecture note. Both delegations remap offsets from the extracted region back onto the real
 * document and re-derive via the shared `buildComment`/`html.ts`'s own region-scanning, the same
 * "position-offsetting, not a simple call-through" approach `html.ts` already uses for
 * `<script>`/`<style>`.
 *
 * Known, deliberate gap: a bare `{expression}` slot in the template (Astro/JSX's own syntax for
 * embedding JS, including the common `{/* comment *​/}` convention for a template-only comment) is
 * not treated as a nested-JS region here. `html.ts` has no notion of `{}` slots at all -- correctly
 * so, since plain HTML has no such syntax -- and giving `astro.ts` its own `{}`-aware scanner is a
 * real undertaking of its own (an attribute value can *be* a bare `{expr}`, with no quotes at all,
 * so finding its true end needs real brace-depth tracking that skips over strings and nested
 * template literals correctly, not a shallow brace count). Per plan §4's own framing ("whether this
 * is cheap or a can of worms is exactly the kind of thing to find out by actually attempting it"):
 * attempting it surfaced that the `{}`-in-attribute-value case makes this deep enough to warrant
 * its own pass, informed by whether real `.astro` files actually lean on `{/* *​/}` comments enough
 * to be worth it -- exactly the kind of thing plan §9.3's corpus-scan-first philosophy argues for
 * over guessing. Until then, a comment inside a `{}` slot is silently left alone: no corruption
 * risk (nothing inside a slot is ever misidentified as a comment delimiter it isn't), just a
 * disclosed coverage gap, not a silent one.
 */
export function findComments(source: string): Comment[] {
  const frontmatter = findFrontmatter(source);
  if (!frontmatter) {
    return findCommentsHtml(source);
  }

  const frontmatterBody = source.slice(frontmatter.bodyStart, frontmatter.bodyEnd);
  const frontmatterComments = findCommentsJs(frontmatterBody).map(comment => ({
    // Overrides `format()`'s own `options.lang` (`'astro'`) for this one comment: it's genuinely
    // TS, so it should expand using JS/TS's `* ` star convention (plan §4).
    ...buildComment(
      comment.kind,
      source,
      comment.start + frontmatter.bodyStart,
      comment.end + frontmatter.bodyStart
    ),
    lang: 'js' as const
  }));

  const templateComments = findCommentsHtml(source, frontmatter.templateStart, source.length).map(
    comment => ({
      ...comment,
      // `?? 'html'` only, not an unconditional override: `html.ts`'s own `<script>`/`<style>`
      // delegation already tags a nested JS/CSS comment with the right `lang` (plan §4), and
      // clobbering that back to `'html'` here would lose the star convention for a `<style>` block
      // sitting inside this template -- confirmed as a real bug, not a hypothetical one, by the
      // `template-script-and-style-still-delegate` fixture losing its `* ` prefix during review.
      lang: comment.lang ?? 'html'
    })
  );

  return [...frontmatterComments, ...templateComments];
}

/*
 * Helpers.
 */

/**
 * Finds an `.astro` file's frontmatter fence, or `undefined` if the file has none (Astro doesn't
 * require one) or an opening `---` never finds a real closing line. Both fence lines must contain
 * nothing but `---` (trimmed) -- a template that happens to start with a horizontal-rule-like
 * `---` followed by other content on the same line isn't a frontmatter fence.
 *
 * A frontmatter body containing a line that's *exactly* `---` in its own right (inside a string or
 * template literal, e.g.) would be misread as an early close by this line-based search, since
 * finding the real closing fence would need actual JS tokenizing to know that line is inside a
 * string, not real fence syntax. Accepted as a known, rare edge case rather than solved here.
 */
function findFrontmatter(source: string): Frontmatter | undefined {
  if (!source.startsWith(FENCE)) {
    return undefined;
  }
  const openLineEnd = source.indexOf('\n', FENCE.length);
  if (openLineEnd === -1 || source.slice(FENCE.length, openLineEnd).trim() !== '') {
    return undefined;
  }

  const bodyStart = openLineEnd + 1;
  let lineStart = bodyStart;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const lineText = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    if (lineText.trim() === FENCE) {
      return {bodyStart, bodyEnd: lineStart, templateStart: lineEnd === -1 ? source.length : lineEnd + 1};
    }
    if (lineEnd === -1) {
      return undefined; // No closing fence found before EOF.
    }
    lineStart = lineEnd + 1;
  }
  return undefined;
}
