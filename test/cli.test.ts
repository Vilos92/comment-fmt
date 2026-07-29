// CLI end-to-end tests (plan §12 Phase 3). Each test builds a scratch directory under
// `os.tmpdir()`, runs `runCli` directly against it, and asserts both the returned exit code and
// the resulting filesystem/stdout state. Never touches this repo's own files.
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, test, vi} from 'vite-plus/test';

import {runCli} from '../src/cli/index.ts';

/*
 * Constants.
 */

// One line comment word repeated enough times to overflow the 110-column default `maxLength`,
// used across tests as a deliberately over-width fixture.
const OVERFLOWING_COMMENT_LINE =
  '// this comment line is intentionally long enough that it overflows the default one hundred and ten column limit for testing';
const SHORT_COMMENT_LINE = '// short';

/*
 * Tests.
 */

describe('cli', () => {
  let scratchDir: string;
  let stdout: string[];
  let stderr: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'comment-fmt-cli-'));
    stdout = [];
    stderr = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      stdout.push(String(chunk));
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rmSync(scratchDir, {recursive: true, force: true});
  });

  describe('flag validation', () => {
    test('exits 2 when no mode flag is given', () => {
      const exitCode = runCli([], scratchDir);
      expect(exitCode).toBe(2);
      expect(stderr.join('')).toContain('Usage');
    });

    test('exits 2 when more than one mode flag is given', () => {
      const exitCode = runCli(['--check', '--write'], scratchDir);
      expect(exitCode).toBe(2);
      expect(stderr.join('')).toContain('Usage');
    });

    test('exits 2 on an unknown flag', () => {
      const exitCode = runCli(['--bogus'], scratchDir);
      expect(exitCode).toBe(2);
    });
  });

  describe('--check', () => {
    test('exits 0 and writes nothing when no file would change', () => {
      const filePath = join(scratchDir, 'clean.js');
      const original = `${SHORT_COMMENT_LINE}\nconst x = 1;\n`;
      writeFileSync(filePath, original);

      const exitCode = runCli(['--check', filePath], scratchDir);

      expect(exitCode).toBe(0);
      expect(readFileSync(filePath, 'utf8')).toBe(original);
      expect(stdout.join('')).not.toContain('Tip:');
    });

    test('exits 1, reports the file, and does not write when a file would change', () => {
      const filePath = join(scratchDir, 'overflow.js');
      const original = `${OVERFLOWING_COMMENT_LINE}\nconst x = 1;\n`;
      writeFileSync(filePath, original);

      const exitCode = runCli(['--check', filePath], scratchDir);

      expect(exitCode).toBe(1);
      expect(readFileSync(filePath, 'utf8')).toBe(original);
      const output = stdout.join('');
      expect(output).toContain('overflow.js');
      expect(output).toContain('comment-fmt-ignore');
    });
  });

  describe('--write', () => {
    test('rewrites an overflowing file in place and exits 0', () => {
      const filePath = join(scratchDir, 'overflow.js');
      const original = `${OVERFLOWING_COMMENT_LINE}\nconst x = 1;\n`;
      writeFileSync(filePath, original);

      const exitCode = runCli(['--write', filePath], scratchDir);

      expect(exitCode).toBe(0);
      const rewritten = readFileSync(filePath, 'utf8');
      expect(rewritten).not.toBe(original);
      expect(rewritten.split('\n').every(line => line.length <= 110)).toBe(true);
    });

    test('leaves an already-clean file untouched and exits 0', () => {
      const filePath = join(scratchDir, 'clean.js');
      const original = `${SHORT_COMMENT_LINE}\nconst x = 1;\n`;
      writeFileSync(filePath, original);

      const exitCode = runCli(['--write', filePath], scratchDir);

      expect(exitCode).toBe(0);
      expect(readFileSync(filePath, 'utf8')).toBe(original);
    });

    test('skips a file extension with no formatter, such as .css, without error', () => {
      const filePath = join(scratchDir, 'styles.css');
      const original = `${OVERFLOWING_COMMENT_LINE.replace('//', '/*')} */\nbody { color: red; }\n`;
      writeFileSync(filePath, original);

      const exitCode = runCli(['--write', filePath], scratchDir);

      expect(exitCode).toBe(0);
      expect(readFileSync(filePath, 'utf8')).toBe(original);
    });
  });

  describe('--diff', () => {
    test('exits 0 and prints nothing when no file would change', () => {
      const filePath = join(scratchDir, 'clean.js');
      writeFileSync(filePath, `${SHORT_COMMENT_LINE}\nconst x = 1;\n`);

      const exitCode = runCli(['--diff', filePath], scratchDir);

      expect(exitCode).toBe(0);
      expect(stdout.join('')).toBe('');
    });

    test('exits 1, does not write, and prints a unified diff plus the ignore-tip footer', () => {
      const filePath = join(scratchDir, 'overflow.js');
      const original = `${OVERFLOWING_COMMENT_LINE}\nconst x = 1;\n`;
      writeFileSync(filePath, original);

      const exitCode = runCli(['--diff', filePath], scratchDir);

      expect(exitCode).toBe(1);
      expect(readFileSync(filePath, 'utf8')).toBe(original);
      const output = stdout.join('');
      expect(output).toContain('--- overflow.js');
      expect(output).toContain('+++ overflow.js');
      expect(output).toContain('-//');
      expect(output).toContain('+//');
      expect(output).toContain('comment-fmt-ignore');
    });
  });

  describe('config surface', () => {
    test('honors a comment-fmt.json maxLength override', () => {
      writeFileSync(join(scratchDir, 'comment-fmt.json'), JSON.stringify({maxLength: 40, targetLength: 35}));
      const filePath = join(scratchDir, 'file.js');
      writeFileSync(
        filePath,
        `${SHORT_COMMENT_LINE} but this one is much longer than forty columns\nconst x = 1;\n`
      );

      const exitCode = runCli(['--write', filePath], scratchDir);

      expect(exitCode).toBe(0);
      const rewritten = readFileSync(filePath, 'utf8');
      expect(rewritten.split('\n').every(line => line.length <= 40)).toBe(true);
    });

    test('fails fast with exit code 2 on malformed JSON', () => {
      writeFileSync(join(scratchDir, 'comment-fmt.json'), '{not valid json');
      const filePath = join(scratchDir, 'file.js');
      writeFileSync(filePath, `${SHORT_COMMENT_LINE}\nconst x = 1;\n`);

      const exitCode = runCli(['--check', filePath], scratchDir);

      expect(exitCode).toBe(2);
      expect(stderr.join('')).toContain('comment-fmt.json');
    });

    test('fails fast with exit code 2 when a known key has the wrong type', () => {
      writeFileSync(join(scratchDir, 'comment-fmt.json'), JSON.stringify({maxLength: 'wide'}));
      const filePath = join(scratchDir, 'file.js');
      writeFileSync(filePath, `${SHORT_COMMENT_LINE}\nconst x = 1;\n`);

      const exitCode = runCli(['--check', filePath], scratchDir);

      expect(exitCode).toBe(2);
      expect(stderr.join('')).toContain('maxLength');
    });

    test('fails fast with exit code 2 when maxLength is zero or negative', () => {
      writeFileSync(join(scratchDir, 'comment-fmt.json'), JSON.stringify({maxLength: 0}));
      const filePath = join(scratchDir, 'file.js');
      writeFileSync(filePath, `${SHORT_COMMENT_LINE}\nconst x = 1;\n`);

      const exitCode = runCli(['--check', filePath], scratchDir);

      expect(exitCode).toBe(2);
      expect(stderr.join('')).toContain('positive');
    });

    test('ignore patterns exclude discovered files but not explicit argv', () => {
      writeFileSync(join(scratchDir, 'comment-fmt.json'), JSON.stringify({ignore: ['vendor/**']}));
      const vendorDir = join(scratchDir, 'vendor');
      mkdirSync(vendorDir, {recursive: true});
      const vendorPath = join(vendorDir, 'lib.js');
      const ownPath = join(scratchDir, 'own.js');
      const overflowing = `${OVERFLOWING_COMMENT_LINE}\nconst x = 1;\n`;
      writeFileSync(vendorPath, overflowing);
      writeFileSync(ownPath, overflowing);

      // No argv: falls back to a plain recursive walk (scratchDir isn't a git repo), which is
      // where `ignore` patterns apply. `own.js` still overflows and should be reported.
      const exitCodeDiscovered = runCli(['--check'], scratchDir);
      expect(exitCodeDiscovered).toBe(1);
      expect(stdout.join('')).toContain('own.js');
      expect(stdout.join('')).not.toContain('vendor');

      stdout = [];
      // Given explicitly as argv, the same vendor file is formatted anyway: `ignore` only
      // filters discovery, per plan §6.
      const exitCodeExplicit = runCli(['--check', vendorPath], scratchDir);
      expect(exitCodeExplicit).toBe(1);
      expect(stdout.join('')).toContain('lib.js');
    });
  });
});
