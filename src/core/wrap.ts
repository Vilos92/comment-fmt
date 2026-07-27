import {splitIntoBlocks} from './blocks.ts';
import {
  DEFAULT_MAX_LENGTH,
  DEFAULT_ORPHAN_MIN_RATIO,
  DEFAULT_TARGET_LENGTH,
  ORPHAN_GUARD_MAX_MOVES,
  ORPHAN_GUARD_MIN_WORDS
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
 * Script.
 */

/**
 * Reflows a comment's plain content lines -- no delimiters, no per-line decoration such as a
 * block comment's leading ` * ` -- to fit within `maxLength` columns once `linePrefixWidth`
 * columns of caller-applied decoration (indent plus that decoration) are added back on. The
 * caller strips and re-applies decoration; this function only ever sees and returns bare text.
 *
 * Greedy fill toward `targetLength`, not Knuth-Plass `balance`: adding one word should change the
 * minimum number of lines, not rewrite a whole paragraph, which is what keeps an autofixer's
 * diffs (and `git blame`) trustworthy on every run (plan §7).
 *
 * Step 0 is the tool's primary safety property, not an optimisation: if every line already fits,
 * the input is returned byte-for-byte unchanged -- no block splitting, no normalisation, nothing
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

/** Moves a trailing word from the second-to-last line onto a too-short final line, up to
 * `ORPHAN_GUARD_MAX_MOVES` times, as long as doing so keeps every line within `maxBudget` and the
 * donor line still has more than one word left (plan §7 step 3). */
function applyOrphanGuard(lines: readonly string[], maxBudget: number, orphanMinRatio: number): string[] {
  const result = [...lines];
  let moves = 0;

  while (moves < ORPHAN_GUARD_MAX_MOVES && result.length >= 2) {
    const lastIndex = result.length - 1;
    const lastLine = result[lastIndex] as string;
    if (measure(lastLine) >= maxBudget * orphanMinRatio) {
      break;
    }

    const prevIndex = lastIndex - 1;
    const prevWords = (result[prevIndex] as string).split(' ');
    if (prevWords.length < ORPHAN_GUARD_MIN_WORDS) {
      break;
    }

    const movedWord = prevWords[prevWords.length - 1] as string;
    const newPrevLine = prevWords.slice(0, -1).join(' ');
    const newLastLine = lastLine.length === 0 ? movedWord : `${movedWord} ${lastLine}`;
    if (measure(newPrevLine) > maxBudget || measure(newLastLine) > maxBudget) {
      break;
    }

    result[prevIndex] = newPrevLine;
    result[lastIndex] = newLastLine;
    moves += 1;
  }

  return result;
}
