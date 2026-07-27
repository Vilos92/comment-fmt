import {splitIntoBlocks} from './blocks.ts';

// comment-fmt-ignore
/*
 * Types.
 */

export type BlockShape = 'single-line' | 'multi-line';

// comment-fmt-ignore
/*
 * Entry.
 */

/**
 * `true` if a block comment's content could ever be a candidate for single-line collapse (plan
 * §1, §12 Phase 5): exactly one logical block (plan §7's `blocks.ts` granularity), and that block
 * isn't protected. A directive, a table, or content that splits into more than one block (a blank
 * line between paragraphs, a fenced example, a `@tag` line) can never sensibly sit on one physical
 * line regardless of width, so shape collapse is never attempted for it. Protected content is
 * additionally required to be preserved byte-for-byte (plan §8.1), which reshaping it, even into
 * an equivalent-looking multi-line form, would violate.
 */
export function checkIsCollapsible(
  contentLines: readonly string[],
  extraDirectives: readonly string[]
): boolean {
  const blocks = splitIntoBlocks(contentLines, extraDirectives);
  return blocks.length === 1 && !(blocks[0]?.protected ?? true);
}

/**
 * Decides whether a block comment should collapse onto a single physical line or expand to the
 * multi-line starred form (plan §1), given the width its content would occupy if collapsed onto
 * one line (delimiters included).
 *
 * Two thresholds, not one, create a hysteresis band between them (plan §12 Phase 5): content
 * narrower than `singleLineMaxWidth` always collapses, content wider than `forceMultilineMinWidth`
 * always expands, and content in the gap between the two keeps whatever shape it already has.
 * Without that gap, a comment whose collapsed width sits exactly at the threshold would flip shape
 * on every edit that nudges it a single character either way, "flapping" between forms (plan
 * §14.8's idempotency traps name this failure mode and require a fixture proving the gap works).
 * The two thresholds may be equal (a single hard threshold, no hysteresis); keeping them as
 * separate parameters here, rather than one, makes that a caller's choice, not a structural given.
 */
export function decideBlockShape(
  collapsedWidth: number,
  currentShape: BlockShape,
  singleLineMaxWidth: number,
  forceMultilineMinWidth: number
): BlockShape {
  if (collapsedWidth <= singleLineMaxWidth) {
    return 'single-line';
  }
  if (collapsedWidth > forceMultilineMinWidth) {
    return 'multi-line';
  }
  return currentShape;
}
