import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/audio/feature-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        currentTime: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.{ts,js}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['*.config.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { process: 'readonly' } },
  },
);
