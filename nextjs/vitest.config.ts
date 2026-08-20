import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'

// Load test-only env (DATABASE_URL must target a dedicated test database).
config({ path: '.env.test' })

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // setup.ts wipes every table in beforeEach against a single shared DB.
    // Parallel test files would clobber each other's in-flight rows, so run
    // files serially to keep the test DB consistent.
    fileParallelism: false,
  },
})
