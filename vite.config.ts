import {defineConfig} from 'vite-plus';

export default defineConfig({
  run: {
    cache: true
  },
  staged: {
    '*': 'vp check --fix'
  },
  pack: {
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
    // would silently break what the fixture is asserting.
    ignorePatterns: ['dist/**', 'test/fixtures/**']
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
    // Same reasoning as fmt.ignorePatterns: fixture content isn't held to house lint/type rules.
    ignorePatterns: ['test/fixtures/**']
  }
});
