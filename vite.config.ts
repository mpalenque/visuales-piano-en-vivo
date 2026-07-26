import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/audio/dsp.ts', 'src/control/{protocol,scene-machine,scenes,show-config}.ts', 'src/gestures/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        statements: 80,
        branches: 70,
      },
    },
  },
});
