import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration files share one MongoDB and spawn their own Redis, so run files one after another.
    fileParallelism: false,
  },
});
