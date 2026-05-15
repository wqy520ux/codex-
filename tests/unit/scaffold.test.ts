import { describe, it, expect } from "vitest";
import { ADAPTER_NAME } from "../../src/index.js";

describe("scaffold", () => {
  it("exports a stable adapter name", () => {
    expect(ADAPTER_NAME).toBe("codex-responses-adapter");
  });
});
