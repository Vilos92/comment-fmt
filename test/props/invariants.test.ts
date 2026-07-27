// Property tests for the four invariants in plan §9.1. Run over randomly generated JS snippets
// containing one comment with a randomly generated body, rather than fully arbitrary strings.
// Most arbitrary strings aren't meaningfully JS-shaped, and these properties are about how the
// formatter treats realistic comment content, not about surviving parser-level garbage (the
// fixture corpus in `test/fixtures/js` covers targeted adversarial/degenerate cases instead).
import fc from 'fast-check';
import {describe, expect, test} from 'vite-plus/test';

import {checkIsTableLike} from '../../src/core/predicates.ts';
import {format} from '../../src/index.ts';
import {findComments} from '../../src/lang/js.ts';

// comment-fmt-ignore
/*
 * Types.
 */

type CommentKind = 'line' | 'block-single' | 'block-multi';

// comment-fmt-ignore
/*
 * Constants.
 */

const wordArb = fc
  .string({minLength: 1, maxLength: 24, unit: 'grapheme'})
  .filter(word => !/[\s/*`'"\\]/u.test(word) && word.length > 0);

const urlArb = fc.constantFrom(
  'https://example.com/path/to/something',
  'http://a.b/c?d=e#f',
  'https://docs.example.org/very/long/path/that/pushes/width'
);

const commentWordsArb = fc.array(fc.oneof({weight: 4, arbitrary: wordArb}, {weight: 1, arbitrary: urlArb}), {
  minLength: 1,
  maxLength: 60
});

const commentKindArb = fc.constantFrom('line', 'block-single', 'block-multi') as fc.Arbitrary<CommentKind>;

const RENDER_COMMENT: Record<CommentKind, (pad: string, body: string) => string> = {
  line: (pad, body) => `${pad}// ${body}`,
  'block-single': (pad, body) => `${pad}/* ${body} */`,
  'block-multi': (pad, body) => `${pad}/**\n${pad} * ${body}\n${pad} */`
};

const snippetArb = fc
  .record({words: commentWordsArb, kind: commentKindArb, indent: fc.nat({max: 8})})
  .map(({words, kind, indent}) => {
    const pad = ' '.repeat(indent);
    const body = words.join(' ');
    const comment = RENDER_COMMENT[kind](pad, body);
    return `${comment}\nconst x = 1;\n`;
  });

// comment-fmt-ignore
/*
 * Tests.
 */

describe('invariants', () => {
  test('idempotency: fmt(fmt(x)) === fmt(x)', () => {
    fc.assert(
      fc.property(snippetArb, source => {
        const once = format(source);
        const twice = format(once);
        expect(twice).toBe(once);
      })
    );
  });

  test('content preservation: comment word multiset is unchanged', () => {
    fc.assert(
      fc.property(snippetArb, source => {
        expect(commentWords(format(source))).toEqual(commentWords(source));
      })
    );
  });

  test('width cap: no output line exceeds maxLength unless it holds an unbreakable token or is table-like', () => {
    fc.assert(
      fc.property(snippetArb, source => {
        const out = format(source);
        for (const line of out.split('\n')) {
          if (line.length > 110) {
            const words = line.trim().split(/\s+/u).filter(Boolean);
            const exempt = words.length <= 1 || checkIsTableLike([line]);
            expect(exempt).toBe(true);
          }
        }
      })
    );
  });

  test('code invariance: non-comment token stream is unchanged (property 9.1.4)', () => {
    fc.assert(
      fc.property(snippetArb, source => {
        expect(nonCommentTokenStream(format(source))).toBe(nonCommentTokenStream(source));
      })
    );
  });
});

// comment-fmt-ignore
/*
 * Helpers.
 */

function nonCommentTokenStream(source: string): string {
  const comments = findComments(source);
  let residual = source;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (comment) {
      residual = residual.slice(0, comment.start) + residual.slice(comment.end);
    }
  }
  return residual.replace(/\s+/gu, '');
}

function commentWords(source: string): string[] {
  const words: string[] = [];
  for (const comment of findComments(source)) {
    const body = source.slice(comment.start + comment.open.length, comment.end - comment.close.length);
    for (const line of body.split('\n')) {
      const stripped = line.replace(/^[ \t]*\*?[ \t]?/u, '');
      for (const word of stripped.split(/\s+/u)) {
        if (word.length > 0) {
          words.push(word);
        }
      }
    }
  }
  return words.sort();
}
