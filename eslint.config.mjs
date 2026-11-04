import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// market-sense-h5 ESLint（flat config，ESLint 9）
// 所有权：A13（根工具链）。各 workspace 子包不单独维护 lint 配置，统一在此扩展。
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.terraform/**',
      '**/pnpm-lock.yaml',
      '**/charts/**/charts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node 运行时脚本（infra 门禁 / 根配置）：显式声明 Node globals，避免 no-undef 噪音。
    files: ['infra/**/*.{js,mjs,cjs}', 'eslint.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        structuredClone: 'readonly',
        performance: 'readonly',
        __filename: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // SRE 工具脚本需要输出诊断信息；业务代码如滥用可在子包覆盖。
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
