import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.vitest/**',
      'storage/**',
      'docs/**',
      '**/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Barreras anti SQL-injection: nada de SQL armado con plantillas
      // interpoladas ni sql.raw().
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
          message:
            'No construyas SQL con plantillas de texto: usa Drizzle o consultas parametrizadas ($1, $2).',
        },
        {
          selector:
            "CallExpression[callee.property.name='execute'] > TemplateLiteral[expressions.length>0]",
          message:
            'No construyas SQL con plantillas de texto: usa Drizzle o consultas parametrizadas ($1, $2).',
        },
        {
          selector: "CallExpression[callee.property.name='raw']",
          message: 'Evita sql.raw(): usa parámetros o identificadores de Drizzle.',
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'Prohibido eval/Function: abre la puerta a ejecución de código arbitrario.',
        },
      ],
    },
  },

  {
    files: ['tools/**/*.{mjs,ts}', 'infra/**/*.{mjs,ts}', '**/*.config.{js,mjs,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },

  {
    // Scripts de configuración en CommonJS (por ejemplo el ecosistema de PM2).
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },

  prettierConfig,
);
