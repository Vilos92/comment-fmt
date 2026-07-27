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
    ignorePatterns: ['dist/**']
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
    }
  }
});
