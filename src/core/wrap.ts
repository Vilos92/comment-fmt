import {LIST_MARKER, splitIntoBlocks} from './blocks.ts';
import {
  DEFAULT_MAX_LENGTH,
  DEFAULT_ORPHAN_MIN_RATIO,
  DEFAULT_TARGET_LENGTH,
  ORPHAN_GUARD_WINDOW_LINES
} from './constants.ts';
import {measure} from './measure.ts';
import {checkIsDirective} from './predicates.ts';

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
 * Five steps, referenced by number elsewhere in `core/`:
 *   0. Overflow-only gate: if every line already fits, return it byte-for-byte unchanged.
 *   1. Split the body into logical blocks (blank line / list-item / tag / fence boundaries).
 *   2. Greedily fill only the blocks that contain an overflowing line; others pass through.
 *   3. Orphan guard: re-lay out a short trailing line by pulling a word from the line before it.
 *   4. Hard invariant: no output line may ever exceed `maxLength`.
 *
 * Greedy fill toward `targetLength`, not Knuth-Plass `balance`: adding one word should change the
 * minimum number of lines, not rewrite a whole paragraph, which is what keeps an autofixer's
 * diffs (and `git blame`) trustworthy on every run.
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

  const blocks = splitIntoBlocks(
    splitOverflowingEmbeddedTagLines(lines, maxBudget, extraDirectives),
    extraDirectives
  );

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

/**
 * Splits an `@tag`-shaped token embedded mid-line onto its own physical line, so `blocks.ts`'s
 * existing `checkIsTagLine` boundary rule (which only ever looks at where a line already starts)
 * picks it up the same way it would if the tag had started its own line to begin with. JSDoc's own
 * spec models a block tag as always followed by a line break, so a tag embedded mid-sentence was
 * never conforming even before this tool touches it. Whether it happened to land at a line's start
 * is otherwise incidental, driven only by whether the surrounding text still fit on one line at
 * authoring time, not a signal the reader should have to infer meaning from.
 *
 * Only applies to a line that already overflows `maxBudget`: `wrap()`'s own step 0 gate already
 * guarantees at least one line needs touching by the time this runs, but not every individual line
 * does, and splitting one that already fits would touch content step 0's "if it fits, don't touch
 * it" bias exists specifically to protect.
 *
 * Skips a directive line entirely (`eslint-disable-next-line @typescript-eslint/...`, `@ts-expect-
 * error`, and the rest of `DIRECTIVE_MARKERS`): confirmed live, not hypothetical, splitting one
 * apart is a correctness bug, not a cosmetic one. `eslint-disable-next-line @rule-name` split into
 * two comments silently changes what it disables, exactly the class of bug `checkIsDirective`'s
 * whole-line protection exists to prevent. `splitIntoBlocks` (called right after this) already
 * re-derives the same check per line to decide what's protected, so this duplicates the test but
 * not the protection logic itself.
 */
function splitOverflowingEmbeddedTagLines(
  lines: readonly string[],
  maxBudget: number,
  extraDirectives: readonly string[]
): string[] {
  return lines.flatMap(line => {
    if (measure(line) <= maxBudget || checkIsDirective(line, extraDirectives)) {
      return [line];
    }
    return splitEmbeddedTagLine(line);
  });
}

/**
 * Finds every `@tag`-shaped token in `line` that isn't already effectively at the line's own
 * start, and splits the line there. A real match sits at a word boundary (whitespace immediately
 * before, a letter immediately after) so an email's `@` (always preceded by a non-whitespace
 * local-part character) is never mistaken for one, and is excluded entirely inside a backtick span
 * (`` `@ts-expect-error` `` names a directive, doesn't invoke it). Doesn't track a *multi-word*
 * backtick span (rare, and word-splitting downstream loses that context anyway), only single
 * backtick-wrapped tokens, which is the common case for naming a tag/directive in prose.
 */
function splitEmbeddedTagLine(line: string): string[] {
  const splitPositions: number[] = [];
  let inBacktick = false;
  for (let i = 1; i < line.length; i += 1) {
    const char = line[i];
    if (char === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    const isRealTagStart =
      !inBacktick && char === '@' && /\s/.test(line[i - 1] as string) && /[a-zA-Z]/.test(line[i + 1] ?? '');
    if (isRealTagStart && line.slice(0, i).trim().length > 0) {
      splitPositions.push(i);
    }
  }
  if (splitPositions.length === 0) {
    return [line];
  }

  const parts: string[] = [];
  let start = 0;
  for (const position of splitPositions) {
    parts.push(line.slice(start, position).replace(/\s+$/, ''));
    start = position;
  }
  parts.push(line.slice(start));
  return parts;
}

function fillBlock(
  lines: readonly string[],
  maxBudget: number,
  targetBudget: number,
  orphanMinRatio: number
): string[] {
  const marker = LIST_MARKER.exec(lines[0] ?? '')?.[0];
  if (marker !== undefined) {
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
 * narrowed by the marker's own display width, then re-attached: verbatim on line 1, as a
 * same-width hanging indent on every continuation line, so wrapped text lines up under the first
 * word after the marker -- the same convention markdown/JSDoc tooling already uses for wrapped
 * list items. Applies unconditionally, even when the marker's own width leaves no room to wrap
 * into: `greedyFill` already keeps an unbreakable first word on its own line rather than crashing
 * or looping on a non-positive budget, and that degraded-but-marker-faithful output is still
 * better than the alternative of silently stripping the marker's indentation, which is exactly
 * the bug this function exists to fix in the first place. `measure`, not `.length`, sizes the
 * budget math (`marker.length` for the `.slice` below is correct as-is -- that's a raw
 * string-index operation, not a display-width one).
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

  const markerWidth = measure(marker);
  const narrowedMax = maxBudget - markerWidth;
  const narrowedTarget = targetBudget - markerWidth;
  const hangingIndent = ' '.repeat(markerWidth);
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
 * lines before it, and this step (step 3) can only ever narrow that already-forward-only blast
 * radius further, down to a small fixed window at the very end.
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
