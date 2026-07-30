import {LIST_MARKER, splitIntoBlocks} from './blocks.ts';
import {
  DEFAULT_MAX_LENGTH,
  DEFAULT_ORPHAN_MIN_RATIO,
  DEFAULT_TARGET_LENGTH,
  ORPHAN_GUARD_WINDOW_LINES
} from './constants.ts';
import {measure} from './measure.ts';

/*
 * Types.
 */

export type WrapOptions = {
  readonly maxLength?: number;
  readonly targetLength?: number;
  readonly orphanMinRatio?: number;
  readonly extraDirectives?: readonly string[];
};

/*
 * Entry.
 */

/**
 * Reflows a comment's plain content lines (no delimiters, no per-line decoration such as a
 * block comment's leading ` * `) to fit within `maxLength` columns once `linePrefixWidth`
 * columns of caller-applied decoration (indent plus that decoration) are added back on. The
 * caller strips and re-applies decoration. This function only ever sees and returns bare text.
 *
 * Greedy fill toward `targetLength`, not Knuth-Plass `balance`: adding one word should change the
 * minimum number of lines, not rewrite a whole paragraph, which is what keeps an autofixer's
 * diffs (and `git blame`) trustworthy on every run (plan §7).
 *
 * Step 0 is the tool's primary safety property, not an optimisation. If every line already fits,
 * the input is returned byte-for-byte unchanged: no block splitting, no normalisation, nothing
 * that could touch a hand-aligned table or ASCII diagram that already happens to fit. Untouched
 * input is the overwhelming common case, which is exactly why this gate matters more than any
 * heuristic downstream of it.
 */
export function wrap(lines: readonly string[], linePrefixWidth: number, options: WrapOptions = {}): string[] {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const targetLength = options.targetLength ?? DEFAULT_TARGET_LENGTH;
  const orphanMinRatio = options.orphanMinRatio ?? DEFAULT_ORPHAN_MIN_RATIO;
  const extraDirectives = options.extraDirectives ?? [];

  const maxBudget = maxLength - linePrefixWidth;
  const targetBudget = targetLength - linePrefixWidth;

  if (lines.every(line => measure(line) <= maxBudget)) {
    return [...lines];
  }

  const blocks = splitIntoBlocks(lines, extraDirectives);

  return blocks.flatMap(block => {
    if (block.protected || block.lines.every(line => measure(line) <= maxBudget)) {
      return block.lines;
    }
    return fillBlock(block.lines, maxBudget, targetBudget, orphanMinRatio);
  });
}

/*
 * Helpers.
 */

function fillBlock(
  lines: readonly string[],
  maxBudget: number,
  targetBudget: number,
  orphanMinRatio: number
): string[] {
  const marker = LIST_MARKER.exec(lines[0] ?? '')?.[0];
  // A marker so wide there's no room left to wrap into falls through to the plain path below: the
  // marker (and whatever original indentation it carries) still ends up on line 1 either way, so
  // this only changes whether continuation lines get a hanging indent, never whether the marker
  // itself survives.
  if (marker !== undefined && maxBudget - marker.length > 0) {
    return fillListItemBlock(lines, marker, maxBudget, targetBudget, orphanMinRatio);
  }

  const words = lines
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0);
  if (words.length === 0) {
    return [...lines];
  }
  return applyOrphanGuard(greedyFill(words, targetBudget, maxBudget), maxBudget, orphanMinRatio);
}

/**
 * Wraps a list-item block (one whose first line starts with a `-`/`*`/`+`/`1.`-style marker,
 * per `blocks.ts`'s own boundary rule) so overflow doesn't strip the marker's own indentation or
 * leave its continuation lines flush with the block's base prefix. Confirmed as a real bug, not
 * theoretical: `fillBlock`'s original `lines.join(' ').trim()` discarded a marker's leading
 * whitespace outright, and greedy-fill had no notion of a marker at all, so a two-item list where
 * only item 1 overflowed came out with item 1's indent stripped while item 2 (untouched) kept its
 * original indent -- a visibly misaligned list from a single line's overflow.
 *
 * `marker` (already known to be `lines[0]`'s own leading whitespace + bullet/number + trailing
 * spaces, exactly as the author wrote it) is spliced off before pooling words, wrapped at a budget
 * narrowed by the marker's own width, then re-attached: verbatim on line 1, as a same-width
 * hanging indent on every continuation line, so wrapped text lines up under the first word after
 * the marker -- the same convention markdown/JSDoc tooling already uses for wrapped list items.
 */
function fillListItemBlock(
  lines: readonly string[],
  marker: string,
  maxBudget: number,
  targetBudget: number,
  orphanMinRatio: number
): string[] {
  const restLines = [(lines[0] as string).slice(marker.length), ...lines.slice(1)];
  const words = restLines
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0);
  if (words.length === 0) {
    return [...lines];
  }

  const narrowedMax = maxBudget - marker.length;
  const narrowedTarget = targetBudget - marker.length;
  const hangingIndent = ' '.repeat(marker.length);
  const wrapped = applyOrphanGuard(
    greedyFill(words, narrowedTarget, narrowedMax),
    narrowedMax,
    orphanMinRatio
  );

  return wrapped.map((line, idx) => (idx === 0 ? `${marker}${line}` : `${hangingIndent}${line}`));
}

/**
 * Packs `words` onto lines, adding one more to the current line as long as doing so stays within
 * `targetBudget`. `maxBudget` is checked too so the hard cap still holds even if a caller passes
 * `targetLength > maxLength`; the effective cutoff is always the smaller of the two.
 */
function greedyFill(words: readonly string[], targetBudget: number, maxBudget: number): string[] {
  const filledLines: string[] = [];
  let currentWords: string[] = [];
  let currentLength = 0;

  for (const word of words) {
    const lengthIfAdded = currentWords.length === 0 ? word.length : currentLength + 1 + word.length;
    const shouldWrap = currentWords.length > 0 && (lengthIfAdded > maxBudget || lengthIfAdded > targetBudget);

    if (shouldWrap) {
      filledLines.push(currentWords.join(' '));
      currentWords = [word];
      currentLength = word.length;
    } else {
      currentWords.push(word);
      currentLength = lengthIfAdded;
    }
  }
  if (currentWords.length > 0) {
    filledLines.push(currentWords.join(' '));
  }
  return filledLines;
}

/**
 * When the final line is a short orphan, re-lays out just the last `ORPHAN_GUARD_WINDOW_LINES`
 * lines (or fewer, if the block is shorter) to split their pooled words more evenly, instead of
 * leaving the rest of the greedy fill's tight packing untouched. Lines before the window are
 * never read or rewritten. That's what keeps this local in the same sense greedy fill is local: a
 * change far from the end of a long comment can only affect lines from that point forward, never
 * lines before it, and this step can only ever narrow that already-forward-only blast radius
 * further, down to a small fixed window at the very end (plan §7 step 3).
 */
function applyOrphanGuard(lines: readonly string[], maxBudget: number, orphanMinRatio: number): string[] {
  if (lines.length < 2) {
    return [...lines];
  }

  const lastLine = lines[lines.length - 1] as string;
  if (measure(lastLine) >= maxBudget * orphanMinRatio) {
    return [...lines];
  }

  const windowSize = Math.min(lines.length, ORPHAN_GUARD_WINDOW_LINES);
  const windowStart = lines.length - windowSize;
  const windowWords = lines
    .slice(windowStart)
    .join(' ')
    .split(' ')
    .filter(word => word.length > 0);

  const rebalanced = rebalanceIntoLines(windowWords, windowSize, maxBudget);
  if (!rebalanced) {
    // No split into exactly `windowSize` lines exists within `maxBudget`. Shouldn't happen in
    // practice (the window's own original lines are always themselves a valid witness), but this
    // is `core/`, so fail safe and leave the greedy fill's own split alone rather than assume that
    // invariant holds forever.
    return [...lines];
  }

  return [...lines.slice(0, windowStart), ...rebalanced];
}

/**
 * Finds the partition of `words` into exactly `numLines` lines, each within `maxBudget`, that
 * minimizes the sum of squared leftover space per line: the most evenly filled split achievable
 * at that line count. A small, line-count-constrained variant of the classic word-wrap dynamic
 * program (Knuth & Plass's line-breaking cost function, minus the interword-glue stretch/shrink
 * modeling that only matters for justified text). `words` here is a handful of lines' worth
 * pooled together, so this stays cheap even in a pathological all-tiny-words case. Returns
 * `undefined` if no split into exactly `numLines` lines fits within `maxBudget`.
 */
function rebalanceIntoLines(
  words: readonly string[],
  numLines: number,
  maxBudget: number
): string[] | undefined {
  const n = words.length;
  const wordWidths = words.map(word => word.length);

  function lineWidth(start: number, end: number): number {
    let width = -1; // No leading space before the first word.
    for (let i = start; i < end; i += 1) {
      width += (wordWidths[i] as number) + 1;
    }
    return width;
  }

  function lineCost(start: number, end: number): number {
    const width = lineWidth(start, end);
    if (width > maxBudget) {
      return Number.POSITIVE_INFINITY;
    }
    const slack = maxBudget - width;
    return slack * slack;
  }

  // `cost[k][i]`: minimum total cost of placing words[0..i) onto exactly k lines. `breakAt[k][i]`:
  // the start index of that arrangement's final line, for reconstructing the split afterward.
  const cost: number[][] = Array.from({length: numLines + 1}, () =>
    new Array(n + 1).fill(Number.POSITIVE_INFINITY)
  );
  const breakAt: number[][] = Array.from({length: numLines + 1}, () => new Array(n + 1).fill(-1));
  (cost[0] as number[])[0] = 0;

  for (let k = 1; k <= numLines; k += 1) {
    for (let i = 1; i <= n; i += 1) {
      for (let j = 0; j < i; j += 1) {
        const previousCost = (cost[k - 1] as number[])[j] as number;
        if (previousCost === Number.POSITIVE_INFINITY) {
          continue;
        }
        const total = previousCost + lineCost(j, i);
        if (total < ((cost[k] as number[])[i] as number)) {
          (cost[k] as number[])[i] = total;
          (breakAt[k] as number[])[i] = j;
        }
      }
    }
  }

  if ((cost[numLines] as number[])[n] === Number.POSITIVE_INFINITY) {
    return undefined;
  }

  const breaks: number[] = [n];
  let index = n;
  for (let k = numLines; k > 0; k -= 1) {
    index = (breakAt[k] as number[])[index] as number;
    breaks.push(index);
  }
  breaks.reverse();

  const result: string[] = [];
  for (let i = 0; i < numLines; i += 1) {
    result.push(words.slice(breaks[i] as number, breaks[i + 1] as number).join(' '));
  }
  return result;
}
