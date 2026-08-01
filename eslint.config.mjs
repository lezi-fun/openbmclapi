import eslint from '@eslint/js'
import nodePlugin from 'eslint-plugin-n'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist'],
  },
  eslint.configs.recommended,
  nodePlugin.configs['flat/recommended-module'],
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
    },
  },
  eslintPluginPrettierRecommended,
)
