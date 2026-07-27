/* Constants. */

/** Hard cap. No output line may ever exceed this width. See `wrap.ts` step 0 and step 4. */
export const DEFAULT_MAX_LENGTH = 110;

/**
 * Soft target the greedy fill wraps toward. Always `<= maxLength`. The gap is deliberate
 * headroom for the orphan guard to move a word without breaking the hard cap.
 */
export const DEFAULT_TARGET_LENGTH = 105;

/**
 * Orphan guard threshold, as a fraction of `maxLength`. A final line narrower than
 * `maxLength * orphanMinRatio` is a candidate to pull a word back from the previous line.
 * Empirically tuned during rollout (plan §6, §11), not derived.
 *
 * Plan §6 describes a `COMMENT_FMT_ORPHAN_RATIO` env-var override for that tuning pass. It
 * deliberately doesn't live here: this is `core/`, which stays pure and takes options in as plain
 * values (plan §4's hard rule: no `node:*`, including the ambient `process` global). Reading
 * an env var to silently change a public API's (`format()`/`wrap()`) default behavior is exactly
 * the kind of surprising, hard-to-reproduce impurity that rule exists to prevent. When the Phase 7
 * tuning pass needs this, wire it explicitly in `cli/` (Phase 3) as a flag that resolves to a real
 * `WrapOptions.orphanMinRatio` value. It should not be ambient state a library caller can't see or override.
 */
export const DEFAULT_ORPHAN_MIN_RATIO = 0.3;

/**
 * How many trailing lines the orphan guard re-lays out when the final line is a short orphan.
 * Bigger windows make the touched lines more evenly filled among themselves, at the cost of a more
 * visible step down from the untouched lines right before the window. 3 tested as the sweet spot
 * during design: 2 doesn't fully fix the worst orphans (a single tiny trailing word barely moves
 * the needle), 4+ starts trading a bigger cliff for evenness gains that are hard to see. Same
 * empirical-tuning status as `DEFAULT_ORPHAN_MIN_RATIO` above.
 */
export const ORPHAN_GUARD_WINDOW_LINES = 3;

/**
 * Above this many columns (collapsed onto one physical line, delimiters included), a block
 * comment expands to the multi-line starred form rather than staying on one line (plan §1, §12
 * Phase 5). Set to `DEFAULT_TARGET_LENGTH`'s value: the same "stay a bit under the hard cap"
 * reasoning as that constant, not a coincidence, but kept as its own named constant rather than a
 * direct reference to it, since a future tuning pass may need to move the two independently (word-
 * wrap fill target vs. block-shape hysteresis are related but distinct concerns).
 */
export const DEFAULT_SINGLE_LINE_MAX_WIDTH = 105;

/**
 * Below this many columns, a multi-line block comment collapses back to a single line; above it,
 * it stays multi-line regardless of `DEFAULT_SINGLE_LINE_MAX_WIDTH`. Set to `DEFAULT_MAX_LENGTH`'s
 * value: a comment whose collapsed form would exceed the hard cap plainly cannot be single-line.
 * The gap between this and `DEFAULT_SINGLE_LINE_MAX_WIDTH` is the hysteresis band `reshape.ts`
 * documents: it stops a comment from flipping shape on every edit that nudges its collapsed width
 * a single character past a single hard threshold.
 */
export const DEFAULT_FORCE_MULTILINE_MIN_WIDTH = 110;
