import { spawnSync } from "node:child_process";

/** True when a `redis-server` binary can be run (integration tests start their own throwaway instance). */
export const hasRedisServer: boolean = (() => {
  try { return spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0; } catch { return false; }
})();

const flag = (name: string) => ["1", "true", "yes"].includes((process.env[name] ?? "").toLowerCase());

/**
 * Skipped tests must never look like passing tests in CI. With REQUIRE_INTEGRATION=1 a missing dependency
 * (redis-server, a MongoDB-compatible server) FAILS the run instead of silently skipping.
 * With REQUIRE_REAL_MONGO=1 an emulator such as FerretDB is not accepted either: the atomicity tests must run.
 */
export function requireOrWarn(file: string, ok: boolean, what: string, flagName = "REQUIRE_INTEGRATION"): void {
  if (ok) return;
  if (flag(flagName)) throw new Error(`[${file}] ${flagName} is set but ${what}`);
  console.warn(`[${file}] ${what}: affected tests are SKIPPED (set ${flagName}=1 to make this an error).`);
}
