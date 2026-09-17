import { describe, it, expect } from "vitest";
import fc from "fast-check";

describe("test infrastructure smoke test", () => {
  it("runs a basic assertion", () => {
    expect(true).toBe(true);
    expect(1 + 1).toBe(2);
  });

  it("uses globals from the setup file (deterministic environment)", () => {
    expect(process.env.TZ).toBe("UTC");
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("runs a trivial fast-check property (integer addition is commutative)", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
    );
  });
});
