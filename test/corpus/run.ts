#!/usr/bin/env bun
// Differential corpus harness (plan §9.3). Runs `format()` over large volumes of *real* code
// rather than synthetic fixtures, and reports every file the tool wants to change. Findings here
// aren't all equally severe. A code-invariance violation (property 9.1.4: the non-comment token
// stream must be byte-identical before and after) means the lexer mistook code for a comment and
// corrupted a file, so even one anywhere in a real corpus is a stop-the-world bug. A file that
// errored partway through (unreadable, or `format()` itself threw) also fails the run, since a
// scan that never finished reading every file has nothing meaningful to say about the corpus it
// skipped. An ordinary "this file would change" count is just the net catching candidates for
// manual triage or sampling, not a failure by itself. Invoked directly with `bun`
// (`./test/corpus/fetch.sh && bun test/corpus/run.ts corpus/* node_modules`, where `fetch.sh`
// clones the standard 15-repo corpus into the git-ignored `corpus/` directory), not through
// `vp test`. Deliberately not wired into any CI job, scheduled or otherwise: this is slow, noisy
// by design (an ordinary changed-file count isn't a failure), and meant to be run by hand
// whenever a change to `core/` or a `lang/*.ts` lexer warrants re-checking against real code.
import {readFileSync, readdirSync} from 'node:fs';
import type {Dirent} from 'node:fs';
import {extname, join} from 'node:path';

import {format, type Lang} from '../../src/index.ts';
import {findComments as findCommentsCss} from '../../src/lang/css.ts';
import {findComments as findCommentsJs} from '../../src/lang/js.ts';
import type {Comment} from '../../src/lang/types.ts';

// comment-fmt-ignore
/*
 * Types.
 */

type ScanTotals = {
  scanned: number;
  changed: number;
};

type InvarianceViolation = {
  readonly path: string;
};

type FileError = {
  readonly path: string;
  readonly message: string;
};

// comment-fmt-ignore
/*
 * Constants.
 */

// `node_modules` is deliberately NOT in this set (plan §9.3: scanning it is the point, it's
// "enormous, free, and stylistically diverse"). Only version control internals are skipped.
const DIRECTORIES_TO_SKIP: ReadonlySet<string> = new Set(['.git']);

/** Which `Lang` (plan §4) each formattable extension maps to. HTML has no lexer yet. */
const LANG_BY_EXTENSION: Readonly<Record<string, Lang>> = {
  '.js': 'js',
  '.jsx': 'js',
  '.ts': 'js',
  '.tsx': 'js',
  '.css': 'css',
  '.scss': 'css'
};

// comment-fmt-ignore
/*
 * Entry.
 */

function main(): void {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    process.stderr.write('Usage: bun test/corpus/run.ts <root-dir> [...more-root-dirs]\n');
    process.exit(2);
  }

  // A root the caller explicitly named failing to even open is a usage error worth surfacing
  // immediately, distinct from a descendant directory going bad partway through a deep recursive
  // walk (handled inside `walkFiles` itself, which records and continues past those instead).
  for (const root of roots) {
    try {
      readdirSync(root, {withFileTypes: true});
    } catch (error) {
      process.stderr.write(`Could not read root directory ${root}: ${(error as Error).message}\n`);
      process.exit(2);
    }
  }

  const totals: ScanTotals = {scanned: 0, changed: 0};
  const invarianceViolations: InvarianceViolation[] = [];
  const errors: FileError[] = [];

  // One file at a time: `walkFiles` is a generator so this never holds the whole corpus's file
  // list, let alone file contents, in memory at once. Only the small running totals/violation/
  // error arrays above accumulate across tens of thousands of files.
  for (const root of roots) {
    for (const path of walkFiles(root, errors)) {
      scanOneFile(path, totals, invarianceViolations, errors);
    }
  }

  printReport(totals, invarianceViolations, errors);
  // A code-invariance violation is the most severe finding this harness treats as fatal (plan
  // §9.3). A file that errored partway through (unreadable, or a genuine crash in `format()`
  // itself) also fails the run: reporting a clean pass over a scan that never actually finished
  // reading every file would be misleading, exactly the "run in a misleading state" this repo's
  // fail-fast convention warns against. An ordinary changed-file count is a net, not a gate, so it
  // alone never affects the exit code.
  process.exit(invarianceViolations.length > 0 || errors.length > 0 ? 1 : 0);
}

main();

// comment-fmt-ignore
/*
 * Helpers.
 */

function scanOneFile(
  path: string,
  totals: ScanTotals,
  invarianceViolations: InvarianceViolation[],
  errors: FileError[]
): void {
  const lang = LANG_BY_EXTENSION[extname(path)];
  if (!lang) {
    return; // Discovered but not formattable yet (e.g. `.html`, no lexer until later).
  }

  totals.scanned += 1;
  try {
    const original = readFileSync(path, 'utf8');
    const formatted = format(original, {lang});

    if (formatted !== original) {
      totals.changed += 1;
    }

    if (nonCommentTokenStream(original, lang) !== nonCommentTokenStream(formatted, lang)) {
      invarianceViolations.push({path});
    }
  } catch (error) {
    errors.push({path, message: (error as Error).message});
  }
}

/**
 * Property 9.1.4 in harness form: strips every comment span from `source`, then collapses all
 * whitespace, leaving only the non-comment token stream. Identical input/output here means the
 * lexer never mistook code for a comment (or vice versa). Follows the same approach as
 * `nonCommentTokenStream` in `test/props/invariants.test.ts`, just against real files instead of
 * generated ones.
 */
function nonCommentTokenStream(source: string, lang: Lang): string {
  const comments: readonly Comment[] = lang === 'css' ? findCommentsCss(source) : findCommentsJs(source);
  let residual = source;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (comment) {
      residual = residual.slice(0, comment.start) + residual.slice(comment.end);
    }
  }
  return residual.replace(/\s+/gu, '');
}

/**
 * Recursively yields every discoverable file under `root` (any extension `LANG_BY_EXTENSION`
 * knows, plus `.html` so it's at least counted even before it has a lexer), skipping `.git` only
 * (not `node_modules`). A descendant directory that goes unreadable partway through (permissions,
 * a broken symlink, a race with something deleting it mid-scan) is recorded into `errors` and
 * skipped, not allowed to throw out of the generator: one bad directory deep in a 589,000-file
 * corpus shouldn't abort every root still left to scan, and `main()` already fails the run overall
 * whenever `errors` is non-empty.
 */
function* walkFiles(root: string, errors: FileError[]): Generator<string> {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, {withFileTypes: true});
  } catch (error) {
    errors.push({path: root, message: `Could not read directory: ${(error as Error).message}`});
    return;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!DIRECTORIES_TO_SKIP.has(entry.name)) {
        yield* walkFiles(path, errors);
      }
      continue;
    }
    if (entry.isFile() && (LANG_BY_EXTENSION[extname(path)] || extname(path) === '.html')) {
      yield path;
    }
  }
}

function printReport(
  totals: ScanTotals,
  invarianceViolations: readonly InvarianceViolation[],
  errors: readonly FileError[]
): void {
  // Code-invariance violations are surfaced first and loudest (plan §9.3: "worth stopping the
  // world for"), never buried alongside routine "file would change" noise.
  if (invarianceViolations.length > 0) {
    process.stdout.write('\n');
    process.stdout.write('='.repeat(70) + '\n');
    process.stdout.write(`CRITICAL: ${invarianceViolations.length} CODE-INVARIANCE VIOLATION(S) FOUND\n`);
    process.stdout.write(
      'The formatter changed non-comment code in the following file(s). This is a lexer bug.\n'
    );
    process.stdout.write('='.repeat(70) + '\n');
    for (const violation of invarianceViolations) {
      process.stdout.write(`  ${violation.path}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write('Corpus scan summary\n');
  process.stdout.write('--------------------\n');
  process.stdout.write(`Files scanned:              ${totals.scanned}\n`);
  process.stdout.write(`Files changed:               ${totals.changed}\n`);
  process.stdout.write(`Code-invariance violations:  ${invarianceViolations.length}\n`);
  process.stdout.write(`Files errored:               ${errors.length}\n`);

  if (errors.length > 0) {
    process.stdout.write('\nErrored files:\n');
    for (const fileError of errors) {
      process.stdout.write(`  ${fileError.path}: ${fileError.message}\n`);
    }
  }
}
