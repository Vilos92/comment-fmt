// Fixture-pair snapshot harness. Workflow: drop a `<name>.input.<ext>` file in
// `test/fixtures/<lang>/`, run `UPDATE_SNAPSHOTS=1 vp test` to generate the matching
// `<name>.expected.<ext>`, eyeball it, commit both. Re-running without the env var just asserts
// the formatter's output still matches the committed `.expected` file.
//
// `js`, `css`, `html`, and `astro` all have real formatters behind them (`lang/{js,css,html,
// astro}.ts` + `core/`).
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, test} from 'vite-plus/test';

import {format} from '../src/index.ts';

/*
 * Types.
 */

type Lang = 'js' | 'css' | 'html' | 'astro';

type FixtureCase = {
  name: string;
  inputPath: string;
  expectedPath: string;
};

/*
 * Constants.
 */

const LANGS: readonly Lang[] = ['js', 'css', 'html', 'astro'];
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
const INPUT_MARKER = '.input.';
const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === '1';

/*
 * Tests.
 */

for (const lang of LANGS) {
  const cases = discoverFixtures(lang);

  describe(`fixtures/${lang}`, () => {
    if (cases.length === 0) {
      // No fixtures committed yet for this language.
      test.skip('no fixtures yet', () => {});
      return;
    }

    for (const fixtureCase of cases) {
      test(fixtureCase.name, () => {
        const input = readFileSync(fixtureCase.inputPath, 'utf8');
        const actual = format(input, {lang});

        if (UPDATE_SNAPSHOTS) {
          mkdirSync(dirname(fixtureCase.expectedPath), {recursive: true});
          writeFileSync(fixtureCase.expectedPath, actual);
          return;
        }

        // A missing `.expected` file outside update mode must fail, not silently write one and
        // then pass against what it just wrote. That would accept any input with no reviewed
        // golden file to catch a regression against.
        if (!existsSync(fixtureCase.expectedPath)) {
          throw new Error(
            `Missing expected fixture: ${fixtureCase.expectedPath}\n` +
              'Run `UPDATE_SNAPSHOTS=1 vp test` to generate it, review the output, then commit it.'
          );
        }

        const expected = readFileSync(fixtureCase.expectedPath, 'utf8');
        expect(actual).toBe(expected);
      });
    }
  });
}

/*
 * Helpers.
 */

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
