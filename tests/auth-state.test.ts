import { describe, expect, test } from "bun:test";
import {
  isDatabaseNotReadyError,
  isUnauthenticatedAccessEnabled,
  resolveInstanceAuthMode,
} from "../apps/api/src/auth-state";

describe("instance authentication state", () => {
  test("fails closed when production has neither credentials nor users", () => {
    expect(
      resolveInstanceAuthMode({
        allowUnauthenticated: false,
        hasBootstrapCredential: false,
        hasEnabledUser: false,
      }),
    ).toBe("unconfigured");
  });

  test("requires authentication when a bootstrap credential or enabled user exists", () => {
    expect(
      resolveInstanceAuthMode({
        allowUnauthenticated: false,
        hasBootstrapCredential: true,
        hasEnabledUser: false,
      }),
    ).toBe("required");
    expect(
      resolveInstanceAuthMode({
        allowUnauthenticated: false,
        hasBootstrapCredential: false,
        hasEnabledUser: true,
      }),
    ).toBe("required");
  });

  test("allows unauthenticated access only through an explicit opt-in", () => {
    expect(isUnauthenticatedAccessEnabled("true")).toBe(true);
    expect(isUnauthenticatedAccessEnabled(" TRUE ")).toBe(true);
    expect(isUnauthenticatedAccessEnabled(undefined)).toBe(false);
    expect(
      resolveInstanceAuthMode({
        allowUnauthenticated: true,
        hasBootstrapCredential: false,
        hasEnabledUser: false,
      }),
    ).toBe("disabled");
  });

  test("recognizes missing D1 bindings and unapplied migrations", () => {
    expect(isDatabaseNotReadyError(new Error("D1_ERROR: no such table: users"))).toBe(true);
    expect(isDatabaseNotReadyError(new TypeError("Cannot read properties of undefined (reading 'prepare')"))).toBe(true);
    expect(isDatabaseNotReadyError(new Error("network timeout"))).toBe(false);
  });

  test("does not flag routine D1 query errors as database-not-ready", () => {
    expect(isDatabaseNotReadyError(new Error("D1_ERROR: UNIQUE constraint failed: users.username"))).toBe(false);
    expect(isDatabaseNotReadyError(new Error("D1_ERROR: CHECK constraint failed"))).toBe(false);
    expect(isDatabaseNotReadyError(new Error("D1_ERROR: 7500: SQLITE_ERROR"))).toBe(false);
  });
});
