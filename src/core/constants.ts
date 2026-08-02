/*
 * Constants.
 */

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
 * Empirically tuned during rollout, not derived.
 *
 * An env-var override for this constant deliberately doesn't live here: this is `core/`, which
 * stays pure and takes options in as plain values, never reaching into `node:*` (including the
 * ambient `process` global). Reading an env var to silently change a public API's
 * (`format()`/`wrap()`) default behavior would be exactly the kind of surprising, hard-to-reproduce
 * impurity that purity rule exists to prevent. If a future tuning pass needs this, it should be
 * wired explicitly in `cli/` as a flag that resolves to a real `WrapOptions.orphanMinRatio` value,
 * not ambient state a library caller can't see or override.
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
