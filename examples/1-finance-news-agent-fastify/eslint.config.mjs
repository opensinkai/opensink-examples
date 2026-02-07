import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import stylistic from '@stylistic/eslint-plugin';

const base = {
  rules: {
    'no-shadow': [
      'error',
      {
        builtinGlobals: false,
      },
    ],
    '@stylistic/semi': ['error', 'always'],
    '@stylistic/member-delimiter-style': [
      'error',
      {
        multiline: {
          delimiter: 'semi',
          requireLast: true,
        },
        singleline: {
          delimiter: 'semi',
          requireLast: false,
        },
        multilineDetection: 'brackets',
      },
    ],
    '@typescript-eslint/no-empty-object-type': 'off',
    '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
    '@typescript-eslint/no-explicit-any': 'off',
    '@stylistic/multiline-ternary': 'off',
    '@stylistic/object-property-newline': ['error', { allowAllPropertiesOnSameLine: true }],
  },
};

export default defineConfig([
  { files: ['**/*.{js,mjs,cjs,ts,mts,cts}'], languageOptions: { globals: globals.node } },
  tseslint.configs.recommended,
  stylistic.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    rules: base.rules,
  },
]);
