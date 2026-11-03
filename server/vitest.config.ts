import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Database tests share one Postgres database; each test creates its own tenants, but run files
    // one at a time so schema-level tests (counters, NOTIFY) are deterministic.
    fileParallelism: false,
  },
});
