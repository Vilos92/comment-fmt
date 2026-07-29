import {defineConfig} from 'vite-plus';

export default defineConfig({
  run: {
    cache: true
  },
  staged: {
    // An array under one glob key, not two separate keys: `vp staged` (built on lint-staged) runs
    // different glob-key entries concurrently by default, and only a single key's own command
    // list is guaranteed sequential. `comment-fmt` must run strictly after `vp check --fix`
    // completes, not concurrently with it, because oxfmt re-indents comments as part of
    // formatting the code around them and comment-fmt's width math depends on a comment's final
    // indentation. Two separate glob keys measurably reproduced the bug this avoids: a comment
    // landed just past 110 columns after reindent, having been read (and left alone) by
    // comment-fmt before the reindent happened. This must be an array, not one `&&`-joined
    // string: lint-staged does not spawn a shell for a command string, it splits on whitespace
    // and execs directly, so `&&` would be passed as a literal argument rather than run as a
    // shell operator. `bun src/cli/index.ts` runs this repo's own CLI from source, since it
    // dogfoods itself before a published `comment-fmt` binary exists; it's safe to pass every
    // staged file (any extension) to it since the CLI itself already silently skips anything
    // outside `.js`/`.jsx`/`.ts`/`.tsx`.
    '*': ['vp check --fix', 'bun src/cli/index.ts --write']
  },
  pack: {
    entry: ['src/index.ts', 'src/cli/index.ts'],
    dts: {
      tsgo: true
    },
    format: ['esm'],
    sourcemap: true,
    exports: true
  },
  fmt: {
    arrowParens: 'avoid',
    bracketSpacing: false,
    printWidth: 110,
    trailingComma: 'none',
    tabWidth: 2,
    semi: true,
    singleQuote: true,
    sortImports: true,
    sortPackageJson: {sortScripts: true},
    // Fixture pairs are test data, not source. They're deliberately exotic/invalid in places
    // (that's the point), and must stay byte-exact for the snapshot harness. Reformatting one
    // would silently break what the fixture is asserting. `corpus/**` is ephemeral third-party
    // source cloned by `test/corpus/fetch.sh` (plan §9.3) into a git-ignored directory: not ours
    // to reformat, and walking 100,000+ real-world files on every `vp check` would also make it
    // unusably slow.
    ignorePatterns: ['dist/**', 'test/fixtures/**', 'corpus/**']
  },
  lint: {
    plugins: ['typescript', 'import'],
    options: {
      typeAware: true,
      typeCheck: true
    },
    rules: {
      curly: ['error', 'all'],
      'no-nested-ternary': 'error',
      // Gates the explicit `.ts` import-suffix convention required by nodenext resolution.
      'import/extensions': ['error', 'ignorePackages']
    },
    // Same reasoning as `fmt.ignorePatterns` above.
    ignorePatterns: ['test/fixtures/**', 'corpus/**']
  }
});
