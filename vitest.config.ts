import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolveWorkspace = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Las pruebas apuntan al código fuente de cada paquete, así no dependen de
    // que exista `dist/` (lo que permite correr `npm test` sin compilar).
    alias: {
      '@odontocrm/contracts': resolveWorkspace('./packages/contracts/src/index.ts'),
      '@odontocrm/events': resolveWorkspace('./packages/events/src/index.ts'),
      '@odontocrm/db': resolveWorkspace('./packages/db/src/index.ts'),
      '@odontocrm/kernel': resolveWorkspace('./packages/kernel/src/index.ts'),
      '@odontocrm/testing': resolveWorkspace('./packages/testing/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'services/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
    ],
    reporters: process.env.CI ? ['default'] : ['default'],
    testTimeout: 10_000,
  },
});
