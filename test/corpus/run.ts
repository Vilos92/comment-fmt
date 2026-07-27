#!/usr/bin/env bun
// Differential corpus harness (plan §9.3). Runs `format()` over large volumes of *real* code
// rather than synthetic fixtures, and reports every file the tool wants to change. Two failure
// classes matter here, and they are not equally severe. A code-invariance violation (property
// 9.1.4: the non-comment token stream must be byte-identical before and after) means the lexer
// mistook code for a comment and corrupted a file, so even one anywhere in a real corpus is a
// stop-the-world bug. An ordinary "this file would change" count is just the net catching
// candidates for manual triage or sampling, not a failure by itself. Invoked directly with `bun`
// (`bun test/corpus/run.ts <root> [...roots]`), not through `vp test`: this is deliberately not
// part of the per-commit suite (see the weekly-only CI workflow under `.github/workflows/`).
import {readFileSync, readdirSync} from 'node:fs';
import type {Dirent} from 'node:fs';
import {extname, join} from 'node:path';

import {format} from '../../src/index.ts';
import {findComments} from '../../src/lang/js.ts';

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

/*
 * Constants.
 */

// `node_modules` is deliberately NOT in this set (plan §9.3: scanning it is the point, it's
// "enormous, free, and stylistically diverse"). Only version control internals are skipped.
const DIRECTORIES_TO_SKIP: ReadonlySet<string> = new Set(['.git']);

const FORMATTABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.jsx', '.ts', '.tsx']);

/*
 * Entry.
 */

function main(): void {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    process.stderr.write('Usage: bun test/corpus/run.ts <root-dir> [...more-root-dirs]\n');
    process.exit(2);
  }

  const totals: ScanTotals = {scanned: 0, changed: 0};
  const invarianceViolations: InvarianceViolation[] = [];
  const errors: FileError[] = [];

  // One file at a time: `walkFiles` is a generator so this never holds the whole corpus's file
  // list, let alone file contents, in memory at once. Only the small running totals/violation/
  // error arrays above accumulate across tens of thousands of files.
  for (const root of roots) {
    for (const path of walkFiles(root)) {
      scanOneFile(path, totals, invarianceViolations, errors);
    }
  }

  printReport(totals, invarianceViolations, errors);
  // A code-invariance violation is the one finding this harness treats as fatal (plan §9.3). An
  // ordinary changed-file count is a net, not a gate, so it never affects the exit code.
  process.exit(invarianceViolations.length > 0 ? 1 : 0);
}

main();

/*
 * Helpers.
 */

function scanOneFile(
  path: string,
  totals: ScanTotals,
  invarianceViolations: InvarianceViolation[],
  errors: FileError[]
): void {
  totals.scanned += 1;
  try {
    const original = readFileSync(path, 'utf8');
    const formatted = format(original);

    if (formatted !== original) {
      totals.changed += 1;
    }

    if (nonCommentTokenStream(original) !== nonCommentTokenStream(formatted)) {
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

/** Recursively yields every formattable file under `root`, skipping `.git` only (not `node_modules`). */
function* walkFiles(root: string): Generator<string> {
  for (const entry of readEntries(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!DIRECTORIES_TO_SKIP.has(entry.name)) {
        yield* walkFiles(path);
      }
      continue;
    }
    if (entry.isFile() && FORMATTABLE_EXTENSIONS.has(extname(entry.name))) {
      yield path;
    }
  }
}

/**
 * Wraps `readdirSync` in its own try/catch, inlined into the call itself (rather than assigned
 * through an explicit `ReturnType<typeof readdirSync>`-annotated variable) so TypeScript resolves
 * the string-returning `Dirent[]` overload instead of the generic buffer-encoding one.
 */
function readEntries(root: string): Dirent<string>[] {
  try {
    return readdirSync(root, {withFileTypes: true});
  } catch (error) {
    // A root that doesn't exist or isn't readable is a usage error worth surfacing immediately,
    // not silently skipping and reporting zero files scanned as if the corpus were empty.
    throw new Error(`Could not read directory ${root}: ${(error as Error).message}`);
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
