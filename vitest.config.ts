import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig "@/*": "./src/*" so unit tests can import lib modules
      // by their app-style path (e.g. '@/lib/supabase/rest').
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
