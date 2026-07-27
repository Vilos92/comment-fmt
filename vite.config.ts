import {defineConfig} from 'vite-plus';

export default defineConfig({
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
  lint: {
    options: {
      typeAware: true,
      typeCheck: true
    },
    rules: {
      curly: ['error', 'all'],
      'no-nested-ternary': 'error'
    }
  },
  fmt: {
    printWidth: 110,
    semi: true,
    singleQuote: true,
    trailingComma: 'none',
    arrowParens: 'avoid',
    bracketSpacing: false
  }
});
