import { describe, expect, it } from "vitest";
import { applySlippage, deadlineFrom, resolveSwapSide } from "../src/ops/helpers.js";
import { noteFee } from "../src/pool/config.js";
import { XykError } from "../src/errors.js";

describe("applySlippage", () => {
  it("bounds a quote by the requested basis points", () => {
    expect(applySlippage(1000n, 50n)).toBe(995n); // 0.5% worse
    expect(applySlippage(1000n, 0n)).toBe(1000n);
    expect(applySlippage(1n, 9999n)).toBe(0n);
  });

  it("rejects slippage outside [0, 10000)", () => {
    expect(() => applySlippage(1000n, 10_000n)).toThrowError(XykError);
    expect(() => applySlippage(1000n, -1n)).toThrowError(XykError);
  });
});

describe("resolveSwapSide", () => {
  it("maps a token to its pool side", () => {
    expect(resolveSwapSide("t0", "t0", "t1")).toBe(0);
    expect(resolveSwapSide("t1", "t0", "t1")).toBe(1);
  });

  it("rejects an unknown token", () => {
    expect(() => resolveSwapSide("t2", "t0", "t1")).toThrowError(XykError);
  });
});

describe("deadlineFrom", () => {
  it("adds the margin to the block timestamp", () => {
    expect(deadlineFrom(1_000_000n, 3600n)).toBe(1_003_600n);
  });
});

describe("noteFee", () => {
  it("returns the configured fee or zero", () => {
    expect(noteFee({ swap: 5n, mint: 3n }, "swap")).toBe(5n);
    expect(noteFee({ swap: 5n }, "burn")).toBe(0n);
  });
});
