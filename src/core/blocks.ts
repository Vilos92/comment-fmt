import {isDirective, isExampleTag, isFenceLine, isTableLike, isTagLine} from './predicates.ts';

/*
 * Types.
 */

/**
 * A logical unit within a comment body: the granularity `wrap.ts` reflows at. `protected`
 * blocks (blank-line separators, fenced code, directive lines, table-like content) are always
 * passed through unchanged, matching the plan §7 step 0 gate's "if uncertain, don't touch it"
 * bias at block scope instead of whole-comment scope.
 */
export type Block = {
  readonly lines: readonly string[];
  readonly protected: boolean;
};

/*
 * Constants.
 */

const LIST_MARKER = /^\s*([-*+]|\d+[.)])\s/;

/*
 * Script.
 */

/**
 * Splits a comment body's lines into `Block`s. A new block starts at a blank line, a list-item
 * marker, a JSDoc-style `@tag` line, an `@example` region, or a fenced-code boundary. Each is a
 * point where merging across it into one wrapped paragraph would be wrong. A directive line (plan
 * §8.1) always forms its own single-line protected block, whether or not it sits inside an
 * otherwise-wrappable block comment, so only that line is exempted rather than the whole
 * surrounding block.
 */
export function splitIntoBlocks(lines: readonly string[], extraDirectives: readonly string[] = []): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let inFence = false;
  let inExample = false;

  const flush = () => {
    if (current.length > 0) {
      blocks.push({lines: current, protected: isTableLike(current)});
      current = [];
    }
  };

  for (const line of lines) {
    if (isFenceLine(line)) {
      if (!inFence) {
        flush(); // Opening a fence: whatever prose was accumulating is its own block, not part
        // of the fenced one about to start.
      }
      current.push(line);
      if (inFence) {
        blocks.push({lines: current, protected: true});
        current = [];
      }
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      current.push(line);
      continue;
    }

    if (inExample) {
      // Unlike a fence, `@example` has no closing marker. JSDoc runs it until the next tag
      // (including another `@example`, which starts its own region rather than closing this one)
      // or a blank line. Close the region here and fall through to process `line` normally below,
      // rather than `continue`, so its own boundary rule (blank/tag/directive/etc.) still applies.
      if (line.trim() === '' || isTagLine(line)) {
        blocks.push({lines: current, protected: true});
        current = [];
        inExample = false;
      } else {
        current.push(line);
        continue;
      }
    }

    if (isExampleTag(line)) {
      flush();
      inExample = true;
      current.push(line);
      continue;
    }

    if (line.trim() === '') {
      flush();
      blocks.push({lines: [line], protected: true});
      continue;
    }

    if (isDirective(line, extraDirectives)) {
      flush();
      blocks.push({lines: [line], protected: true});
      continue;
    }

    if (isTagLine(line) || LIST_MARKER.test(line)) {
      flush();
    }
    current.push(line);
  }

  // An unterminated fence or a trailing @example with no following boundary still needs its
  // content preserved. Treat it as protected rather than let it fall through to the generic
  // flush below and get reflowed.
  if (inFence || inExample) {
    blocks.push({lines: current, protected: true});
    return blocks;
  }

  flush();
  return blocks;
}
