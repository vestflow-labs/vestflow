import { describe, expect, it } from "vitest";
import {
  DATABASE_POOL_DEFAULTS,
  getDatabasePoolConfig,
} from "../src/config";

describe("database pool configuration", () => {
  it("uses documented defaults", () => {
    expect(getDatabasePoolConfig({})).toEqual({
      min: DATABASE_POOL_DEFAULTS.min,
      max: DATABASE_POOL_DEFAULTS.max,
      idleTimeoutMs: DATABASE_POOL_DEFAULTS.idleTimeoutMs,
    });
  });

  it("accepts custom integer values", () => {
    expect(
      getDatabasePoolConfig({
        DB_POOL_MIN: "2",
        DB_POOL_MAX: "12",
        DB_IDLE_TIMEOUT_MS: "4500",
      }),
    ).toEqual({ min: 2, max: 12, idleTimeoutMs: 4500 });
  });

  it.each([
    [{ DB_POOL_MIN: "nope" }, "DB_POOL_MIN"],
    [{ DB_POOL_MAX: "0" }, "DB_POOL_MAX"],
    [{ DB_IDLE_TIMEOUT_MS: "-1" }, "DB_IDLE_TIMEOUT_MS"],
    [{ DB_POOL_MIN: "5", DB_POOL_MAX: "4" }, "DB_POOL_MIN"],
  ])("rejects invalid values", (env, variable) => {
    expect(() => getDatabasePoolConfig(env)).toThrow(variable);
  });
});
