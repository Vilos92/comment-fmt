#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {extname, join, relative} from 'node:path';
import {parseArgs} from 'node:util';

import {DEFAULT_MAX_LENGTH, DEFAULT_TARGET_LENGTH} from '../core/constants.ts';
import {measure} from '../core/measure.ts';
import {ASCII_BOX_OR_TREE, BOX_DRAWING_CHARS, HAS_PIPE} from '../core/predicates.ts';
import {FIND_COMMENTS_BY_LANG, format, type Lang} from '../index.ts';

/*
 * Types.
 */

type Mode = 'check' | 'write' | 'diff' | 'report-overwidth';

/**
 * Priority-ordered classification for `--report-overwidth`, checked against a comment's original
 * raw lines. First match wins. This is a manual-review sampling tool, not a re-implementation of
 * `checkIsTableLike`: `has-aligned-spaces` is deliberately looser than that detector's real 3-line
 * threshold, specifically to surface near-misses the real Tier-2 heuristic doesn't catch.
 */
type OverwidthGroup =
  | 'has-pipe'
  | 'has-box-drawing'
  | 'has-aligned-spaces'
  | 'has-tag-line'
  | 'single-line'
  | 'prose';

type OverwidthFinding = {
  readonly group: OverwidthGroup;
  readonly text: string;
};

/** Parsed `comment-fmt.json`, every key defaulted so the file itself is fully optional. */
type Config = {
  readonly maxLength: number;
  readonly targetLength: number;
  readonly ignore: readonly string[];
  readonly extraDirectives: readonly string[];
};

type FileResult = {
  readonly path: string;
  readonly original: string;
  readonly formatted: string;
  readonly changed: boolean;
};

type DiffOpKind = 'context' | 'add' | 'remove';

type DiffOp = {readonly kind: DiffOpKind; readonly line: string};

/*
 * Constants.
 */

const CONFIG_FILE_NAME = 'comment-fmt.json';

/**
 * Extensions `format()` actually knows how to reflow. Anything discovered outside this set is
 * silently left alone rather than reported as checked, written, or diffed (currently nothing --
 * every extension `DISCOVERABLE_EXTENSIONS` names now has a real lexer).
 */
const FORMATTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.scss',
  '.html',
  '.astro'
]);

/** Which `Lang` `format()` should use for a given formattable extension. */
const LANG_BY_EXTENSION: Readonly<Record<string, Lang>> = {
  '.js': 'js',
  '.jsx': 'js',
  '.ts': 'js',
  '.tsx': 'js',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.astro': 'astro'
};

/**
 * Full future language scope, used only to decide what file discovery turns up. Kept wider than
 * `FORMATTABLE_EXTENSIONS` so discovery doesn't need to change again the next time a lexer is
 * mid-flight (every extension named here currently has one, so the two sets are identical today --
 * that's expected, not a sign either one is redundant).
 */
const DISCOVERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.scss',
  '.html',
  '.astro'
]);

const IGNORE_TIP =
  'Tip: add // comment-fmt-ignore before a comment, or comment-fmt-ignore-file near the top ' +
  'of a file, to exempt it.';

/** `--check`-only, printed above the file list: `--diff` already shows the fix, so doesn't need it. */
const CHECK_FIX_TIP = 'Run comment-fmt --write to fix, or comment-fmt --diff to preview the changes.';

const USAGE = 'Usage: comment-fmt (--check | --write | --diff | --report-overwidth) [files...]';

const DIRECTORIES_TO_SKIP: ReadonlySet<string> = new Set(['node_modules', '.git']);

const DIFF_PREFIXES: Record<DiffOpKind, string> = {context: ' ', add: '+', remove: '-'};

const PARSE_OPTIONS = {
  check: {type: 'boolean', default: false},
  write: {type: 'boolean', default: false},
  diff: {type: 'boolean', default: false},
  'report-overwidth': {type: 'boolean', default: false}
} as const;

/** Order doubles as `runCli`'s classification priority: first match wins. */
const OVERWIDTH_GROUP_ORDER: readonly OverwidthGroup[] = [
  'has-pipe',
  'has-box-drawing',
  'has-aligned-spaces',
  'has-tag-line',
  'single-line',
  'prose'
];

// No `g` flag: this is only ever used with `.test()`, and a global regex's `lastIndex` state
// would carry over between calls across different lines and silently skip alternating matches.
const RUN_OF_SPACES = / {2,}/;
/** Deliberately looser than `predicates.ts`'s real Tier-2 threshold: 2+ lines, not 3+. */
const OVERWIDTH_ALIGNED_MIN_LINES = 2;

const OVERWIDTH_MAX_EXAMPLES_PER_GROUP = 5;

/*
 * Entry.
 */

/**
 * Runs the CLI end to end and returns an exit code rather than calling `process.exit()` itself,
 * so the argument-parsing and formatting logic stays testable without spawning a real process.
 */
export function runCli(argv: string[], cwd: string): number {
  let parsed: {
    values: {check: boolean; write: boolean; diff: boolean; 'report-overwidth': boolean};
    positionals: string[];
  };
  try {
    parsed = parseArgs({args: argv, allowPositionals: true, options: PARSE_OPTIONS});
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }

  const {check, write, diff, 'report-overwidth': reportOverwidth} = parsed.values;
  const modeCount = Number(check) + Number(write) + Number(diff) + Number(reportOverwidth);
  if (modeCount !== 1) {
    process.stderr.write(
      `${USAGE}\nExactly one of --check, --write, --diff, or --report-overwidth must be given.\n`
    );
    return 2;
  }
  const mode: Mode = computeMode({check, write, diff, reportOverwidth});

  let config: Config;
  try {
    config = loadConfig(cwd);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const files = discoverFiles(parsed.positionals, cwd, config.ignore);
  const formattableFiles = files.filter(path => FORMATTABLE_EXTENSIONS.has(extname(path)));

  let results: FileResult[];
  try {
    results = formattableFiles.map(path => formatFile(path, config));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  if (mode === 'report-overwidth') {
    printOverwidthReport(results, config);
    return 0;
  }

  const changed = results.filter(result => result.changed);

  if (mode === 'write') {
    for (const result of changed) {
      writeFileSync(result.path, result.formatted);
    }
    for (const result of changed) {
      process.stdout.write(`Formatted ${relative(cwd, result.path)}\n`);
    }
    return 0;
  }

  if (changed.length === 0) {
    return 0;
  }

  if (mode === 'diff') {
    for (const result of changed) {
      process.stdout.write(`${renderDiff(relative(cwd, result.path), result.original, result.formatted)}\n`);
    }
  } else {
    process.stdout.write(`${CHECK_FIX_TIP}\n\n`);
    for (const result of changed) {
      process.stdout.write(`${relative(cwd, result.path)}\n`);
    }
  }
  process.stdout.write(`\n${IGNORE_TIP}\n`);
  return 1;
}

// Only reached when run as a real process (see `test/cli.test.ts` for direct `runCli` testing);
// guarded so importing this module never has a side effect of its own.
if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = runCli(process.argv.slice(2), process.cwd());
  process.exit(exitCode);
}

/*
 * Helpers.
 */

function computeMode(flags: {
  readonly check: boolean;
  readonly write: boolean;
  readonly diff: boolean;
  readonly reportOverwidth: boolean;
}): Mode {
  if (flags.check) {
    return 'check';
  }
  if (flags.write) {
    return 'write';
  }
  if (flags.reportOverwidth) {
    return 'report-overwidth';
  }
  return 'diff';
}

function formatFile(path: string, config: Config): FileResult {
  let original: string;
  try {
    original = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }

  const formatted = format(original, {
    lang: LANG_BY_EXTENSION[extname(path)],
    maxLength: config.maxLength,
    targetLength: config.targetLength,
    extraDirectives: config.extraDirectives
  });

  return {path, original, formatted, changed: formatted !== original};
}

/**
 * Loads `comment-fmt.json` from `cwd` if present, defaulting every key. Fails fast on malformed
 * JSON or a wrong-typed known key rather than silently ignoring a broken config, per this repo's
 * fail-fast convention.
 */
function loadConfig(cwd: string): Config {
  const defaults: Config = {
    maxLength: DEFAULT_MAX_LENGTH,
    targetLength: DEFAULT_TARGET_LENGTH,
    ignore: [],
    extraDirectives: []
  };

  const configPath = join(cwd, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    // No config file. Defaults stand; most repos need no file at all.
    return defaults;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CONFIG_FILE_NAME} is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object.`);
  }

  const candidate = parsed as Record<string, unknown>;
  return {
    maxLength: readNumberKey(candidate, 'maxLength', defaults.maxLength),
    targetLength: readNumberKey(candidate, 'targetLength', defaults.targetLength),
    ignore: readStringArrayKey(candidate, 'ignore', defaults.ignore),
    extraDirectives: readStringArrayKey(candidate, 'extraDirectives', defaults.extraDirectives)
  };
}

/**
 * Both `maxLength` and `targetLength` are column budgets, so a non-finite or non-positive value
 * (`0`, a negative number, `NaN`) isn't just an unusual choice, it's a broken config that would
 * otherwise degrade `wrap()` to one word per line instead of failing here with a clear cause.
 */
function readNumberKey(source: Record<string, unknown>, key: string, fallback: number): number {
  if (!(key in source)) {
    return fallback;
  }
  const value = source[key];
  if (typeof value !== 'number') {
    throw new Error(`${CONFIG_FILE_NAME}: "${key}" must be a number, got ${typeof value}.`);
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${CONFIG_FILE_NAME}: "${key}" must be a positive, finite number, got ${value}.`);
  }
  return value;
}

function readStringArrayKey(
  source: Record<string, unknown>,
  key: string,
  fallback: readonly string[]
): readonly string[] {
  if (!(key in source)) {
    return fallback;
  }
  const value = source[key];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${CONFIG_FILE_NAME}: "${key}" must be an array of strings.`);
  }
  return value as string[];
}

/**
 * Resolves the file list to operate on: explicit argv wins outright (the hook path, where
 * `lint-staged` already did the filtering), otherwise a git repo is discovered via `git ls-files`
 * (gitignore-respecting for free), otherwise a plain recursive `node:fs` walk. Only the discovery
 * paths apply `ignore` patterns; explicit argv is used as given.
 */
function discoverFiles(positionals: readonly string[], cwd: string, ignore: readonly string[]): string[] {
  if (positionals.length > 0) {
    return positionals.map(path => (path.startsWith('/') ? path : join(cwd, path)));
  }

  const discovered = checkHasGitRepo(cwd) ? listGitFiles(cwd) : walkDirectory(cwd);
  const matchers = ignore.map(globToRegExp);
  return discovered.filter(path => !matchers.some(matcher => matcher.test(relative(cwd, path))));
}

function checkHasGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {cwd, stdio: ['ignore', 'pipe', 'ignore']});
    return true;
  } catch {
    return false;
  }
}

function listGitFiles(cwd: string): string[] {
  const output = execFileSync('git', ['ls-files'], {cwd, encoding: 'utf8'});
  return output
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => join(cwd, line))
    .filter(path => DISCOVERABLE_EXTENSIONS.has(extname(path)));
}

function walkDirectory(root: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(root, {withFileTypes: true});

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!DIRECTORIES_TO_SKIP.has(entry.name)) {
        results.push(...walkDirectory(path));
      }
      continue;
    }
    if (entry.isFile() && DISCOVERABLE_EXTENSIONS.has(extname(path))) {
      results.push(path);
    }
  }

  return results;
}

/**
 * Converts the common glob subset used by `ignore` patterns to a `RegExp`: `*` matches within one
 * path segment, `**` matches across segments, and every other character is escaped and matched
 * literally. Deliberately not a full glob implementation, just enough for exclude patterns
 * without taking a library dependency (this package ships zero runtime dependencies).
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char?.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Prints the `--report-overwidth` sample: every comment that (a) has at least one original
 * physical line exceeding `config.maxLength` and (b) actually gets changed by `format()` (so a
 * protected/exempted overflow, e.g. a directive or a table the step-0 gate or Tier-2 heuristic
 * already caught, never shows up as a false "miss"), grouped by shape with a bounded example
 * sample per group. Deliberately a manual-review tool, not a pass/fail check: there's no "correct"
 * output here, only a readable sample a human reads to judge whether any `has-*` group contains
 * content that should have been protected but wasn't.
 */
function printOverwidthReport(results: readonly FileResult[], config: Config): void {
  const findingsByGroup = new Map<OverwidthGroup, OverwidthFinding[]>();
  for (const group of OVERWIDTH_GROUP_ORDER) {
    findingsByGroup.set(group, []);
  }

  for (const result of results) {
    for (const finding of collectOverwidthFindings(result, config.maxLength)) {
      (findingsByGroup.get(finding.group) as OverwidthFinding[]).push(finding);
    }
  }

  for (const group of OVERWIDTH_GROUP_ORDER) {
    const findings = findingsByGroup.get(group) as OverwidthFinding[];
    process.stdout.write(`\n${group}: ${findings.length}\n`);
    for (const finding of findings.slice(0, OVERWIDTH_MAX_EXAMPLES_PER_GROUP)) {
      process.stdout.write('---\n');
      process.stdout.write(`${finding.text}\n`);
    }
  }
}

/**
 * Finds every over-width, actually-changed comment in one file's original source and classifies
 * each. Deliberately does not try to match original comments to formatted ones by re-lexing the
 * output and pairing them positionally: a `//` comment that wraps across N physical lines becomes
 * N separate line comments once re-lexed (each with its own `//`), so the comment count can
 * legitimately change and there is no safe index to pair against. Instead, a comment counts as
 * "changed" if its exact original text is no longer present anywhere in the formatted output --
 * true whenever it was actually reflowed, and never a false positive, since an untouched comment's
 * text is always still there verbatim at its own position. The only imprecision this trades away
 * is a file containing two byte-identical over-width comments where just one gets reflowed; a
 * sampling tool (this is explicitly not a pass/fail check) can afford that over the far worse
 * failure mode positional matching had of throwing, or silently mismatching, on ordinary input.
 */
function collectOverwidthFindings(result: FileResult, maxLength: number): OverwidthFinding[] {
  const originalComments = FIND_COMMENTS_BY_LANG[LANG_BY_EXTENSION[extname(result.path)] ?? 'js'](
    result.original
  );

  const findings: OverwidthFinding[] = [];
  for (const comment of originalComments) {
    const text = result.original.slice(comment.start, comment.end);
    const lines = text.split('\n');
    const hasOverwidthLine = lines.some(
      (line, idx) => (idx === 0 ? comment.indent : 0) + measure(line) > maxLength
    );
    if (!hasOverwidthLine) {
      continue;
    }
    if (result.formatted.includes(text)) {
      continue; // Protected/exempted (directive, table, comment-fmt-ignore, ...). Not a miss.
    }

    findings.push({group: classifyOverwidth(lines), text});
  }
  return findings;
}

function classifyOverwidth(lines: readonly string[]): OverwidthGroup {
  if (lines.some(line => HAS_PIPE.test(line))) {
    return 'has-pipe';
  }
  if (lines.some(line => BOX_DRAWING_CHARS.test(line) || ASCII_BOX_OR_TREE.test(line))) {
    return 'has-box-drawing';
  }
  if (checkHasAlignedSpaces(lines)) {
    return 'has-aligned-spaces';
  }
  if (lines.some(line => line.trim().startsWith('@'))) {
    return 'has-tag-line';
  }
  if (lines.length === 1) {
    return 'single-line';
  }
  return 'prose';
}

/**
 * Deliberately looser than `checkIsTableLike`'s real Tier-2 aligned-space detector (which
 * requires 3+ lines at a shared column): this is a sampling tool meant to surface near-misses the
 * real detector doesn't catch, not a re-implementation of it, so 2+ lines with a run of 2+ spaces
 * is enough to flag for manual review.
 */
function checkHasAlignedSpaces(lines: readonly string[]): boolean {
  return lines.filter(line => RUN_OF_SPACES.test(line)).length >= OVERWIDTH_ALIGNED_MIN_LINES;
}

/**
 * Minimal unified-diff renderer for `--diff` output: no external diff library, just a line-level
 * LCS-based hunk between `before` and `after`. Good enough to make `--diff` reviewable, not a
 * general-purpose diff tool.
 */
function renderDiff(path: string, before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const ops = computeLineDiff(beforeLines, afterLines);

  const header = [`--- ${path}`, `+++ ${path}`];
  const body = ops.map(op => `${DIFF_PREFIXES[op.kind]}${op.line}`);
  return [...header, ...body].join('\n');
}

/** Classic O(n*m) LCS table, sized for a single reflowed file rather than arbitrary large inputs. */
function computeLineDiff(before: readonly string[], after: readonly string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = lcs[i] as number[];
      row[j] =
        before[i] === after[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({kind: 'context', line: before[i] as string});
      i += 1;
      j += 1;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      ops.push({kind: 'remove', line: before[i] as string});
      i += 1;
    } else {
      ops.push({kind: 'add', line: after[j] as string});
      j += 1;
    }
  }
  while (i < n) {
    ops.push({kind: 'remove', line: before[i] as string});
    i += 1;
  }
  while (j < m) {
    ops.push({kind: 'add', line: after[j] as string});
    j += 1;
  }
  return ops;
}
