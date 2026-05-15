import { describe, expect, it } from "vitest";

import { deepDiff, SECRET_PATHS } from "../../src/cli/deepDiff.js";

describe("deepDiff", () => {
  it("returns an empty array for structurally identical values", () => {
    const a = { x: 1, y: [1, 2, { z: "s" }] };
    const b = { y: [1, 2, { z: "s" }], x: 1 };
    expect(deepDiff(a, b)).toEqual([]);
  });

  it("reports diffs using RFC 6901 JSON Pointer paths", () => {
    const a = { x: 1, y: { z: "a" } };
    const b = { x: 2, y: { z: "a" } };
    expect(deepDiff(a, b)).toEqual(["/x"]);
  });

  it("reports missing keys on either side", () => {
    const a = { x: 1 };
    const b = { y: 2 };
    expect(deepDiff(a, b)).toEqual(["/x", "/y"]);
  });

  it("diffs array elements positionally and flags length mismatch", () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    const diffs = deepDiff(a, b);
    expect(diffs).toContain("");
    expect(diffs).toContain("/2");
  });

  it("respects ignorePaths with a single-segment wildcard", () => {
    const a = {
      providers: [
        { name: "p1", api_key: "real-secret-1" },
        { name: "p2", api_key: "real-secret-2" },
      ],
    };
    const b = {
      providers: [
        { name: "p1", api_key: "real...et-1" },
        { name: "p2", api_key: "real...et-2" },
      ],
    };
    expect(
      deepDiff(a, b, { ignorePaths: ["/providers/*/api_key"] }),
    ).toEqual([]);
  });

  it("reports differences at non-ignored paths even when secrets match pattern", () => {
    const a = {
      admin_key: "secret-admin",
      providers: [{ name: "p1", api_key: "foo" }],
    };
    const b = {
      admin_key: "masked",
      providers: [{ name: "p2", api_key: "bar" }],
    };
    const diffs = deepDiff(a, b, { ignorePaths: SECRET_PATHS });
    expect(diffs).toContain("/providers/0/name");
    expect(diffs).not.toContain("/admin_key");
    expect(diffs).not.toContain("/providers/0/api_key");
  });

  it("treats array-vs-object mismatches as a single diff at the parent path", () => {
    const a: unknown = { x: [1, 2] };
    const b: unknown = { x: { "0": 1, "1": 2 } };
    expect(deepDiff(a, b)).toEqual(["/x"]);
  });

  it("escapes JSON Pointer segments containing `~` and `/`", () => {
    const a = { "a/b": 1, "c~d": 2 };
    const b = { "a/b": 99, "c~d": 100 };
    const diffs = deepDiff(a, b);
    expect(diffs).toEqual(["/a~1b", "/c~0d"]);
  });

  it("handles null vs object as a scalar mismatch", () => {
    expect(deepDiff({ x: null }, { x: { y: 1 } })).toEqual(["/x"]);
  });
});
