/*
 * Constants.
 */

/** Hard cap. No output line may ever exceed this width. See `wrap.ts` step 0 and step 4. */
export const DEFAULT_MAX_LENGTH = 110;

/** Soft target the greedy fill wraps toward. Always `<= maxLength`. The gap is deliberate
 * headroom for the orphan guard to move a word without breaking the hard cap. */
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

/** Secondary orphan-guard floor: never pull from a previous line with one word or fewer, since a
 * single long token (e.g. "internationalization") isn't an orphan-guard candidate. */
export const ORPHAN_GUARD_MIN_WORDS = 2;

/** Orphan guard stops after this many word-moves even if the final line is still short. */
export const ORPHAN_GUARD_MAX_MOVES = 2;
