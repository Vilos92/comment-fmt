// Fixture-pair snapshot harness (plan §9.5). Workflow: drop a `<name>.input.<ext>` file in
// `test/fixtures/<lang>/`, run `UPDATE_SNAPSHOTS=1 vp test` to generate the matching
// `<name>.expected.<ext>`, eyeball it, commit both. Re-running without the env var just asserts
// the formatter's output still matches the committed `.expected` file.
//
// Phase 1 note: `core/wrap.ts` and the `lang/` lexers don't exist yet (Phase 2+), so `format`
// below is an identity placeholder. It makes this harness structurally exercised end-to-end today
// -- discovery, read, compare/write -- without asserting anything about real formatting. Replace
// `format` with the real export from `../src/index.ts` once Phase 2 lands, and delete this note.
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vite-plus/test';

type Lang = 'js' | 'css' | 'html';

function format(input: string, _lang: Lang): string {
  return input;
}

const LANGS: readonly Lang[] = ['js', 'css', 'html'];
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const INPUT_MARKER = '.input.';
const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === '1';

interface FixtureCase {
  name: string;
  inputPath: string;
  expectedPath: string;
}

function discoverFixtures(lang: Lang): FixtureCase[] {
  const dir = join(FIXTURES_DIR, lang);
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter(file => file.includes(INPUT_MARKER))
    .map(file => {
      const markerIndex = file.indexOf(INPUT_MARKER);
      const name = file.slice(0, markerIndex);
      const ext = file.slice(markerIndex + INPUT_MARKER.length);
      return {
        name,
        inputPath: join(dir, file),
        expectedPath: join(dir, `${name}.expected.${ext}`)
      };
    });
}

for (const lang of LANGS) {
  const cases = discoverFixtures(lang);

  describe(`fixtures/${lang}`, () => {
    if (cases.length === 0) {
      // No fixtures committed yet for this language -- expected until Phase 2/6 add them.
      test.skip('no fixtures yet', () => {});
      return;
    }

    for (const fixtureCase of cases) {
      test(fixtureCase.name, () => {
        const input = readFileSync(fixtureCase.inputPath, 'utf8');
        const actual = format(input, lang);

        if (UPDATE_SNAPSHOTS || !existsSync(fixtureCase.expectedPath)) {
          mkdirSync(dirname(fixtureCase.expectedPath), {recursive: true});
          writeFileSync(fixtureCase.expectedPath, actual);
          return;
        }

        const expected = readFileSync(fixtureCase.expectedPath, 'utf8');
        expect(actual).toBe(expected);
      });
    }
  });
}
