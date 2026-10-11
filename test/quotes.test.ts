import { describe, expect, it } from "vitest";
import {
  PoolMathError,
  amountOut,
  divCeil,
  isqrt,
  quoteBurn,
  quoteMint,
  type PoolMathErrorKind,
  type SwapQuote,
} from "../src/math/quotes.js";
import { MAX_AMOUNT, MINIMUM_LIQUIDITY } from "../src/constants.js";

const LP_FEE_BPS = 30n;
const PROTOCOL_FEE_SHARE_BPS = 1200n;

/** Thrown kind, or null when the call succeeds. */
function thrownKind(fn: () => unknown): PoolMathErrorKind | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof PoolMathError) {
      return error.kind;
    }
    throw error;
  }
}

/** Reference `amountOut` used only to cross-check the SDK over many inputs. */
function refAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  lpFeeBps: bigint,
  protocolFeeShareBps: bigint,
): SwapQuote {
  if (amountIn === 0n) throw new PoolMathError("ZeroAmountIn");
  if (reserveIn === 0n || reserveOut === 0n) throw new PoolMathError("EmptyPool");
  if (amountIn > MAX_AMOUNT || reserveIn > MAX_AMOUNT || reserveOut > MAX_AMOUNT) {
    throw new PoolMathError("Overflow");
  }
  const lpFee = (lpFeeBps * amountIn) / 10_000n;
  const protocolFee = (protocolFeeShareBps * lpFee) / 10_000n;
  const amountInWithFee = amountIn * (10_000n - lpFeeBps);
  const out =
    (amountInWithFee * reserveOut) /
    (reserveIn * 10_000n + amountInWithFee);
  if (out === 0n) throw new PoolMathError("ZeroAmountOut");
  if (out >= reserveOut) throw new PoolMathError("InsufficientLiquidity");
  const reserveInAfter = reserveIn + (amountIn - protocolFee);
  if (reserveInAfter >= MAX_AMOUNT) throw new PoolMathError("Overflow");
  return {
    amountOut: out,
    reserveInAfter,
    reserveOutAfter: reserveOut - out,
    protocolFee,
  };
}

describe("isqrt", () => {
  it("matches floor sqrt on small values", () => {
    for (let n = 0n; n <= 2000n; n += 1n) {
      expect(isqrt(n), `isqrt(${n})`).toBe(BigInt(Math.floor(Math.sqrt(Number(n)))));
    }
  });

  it("handles large perfect squares", () => {
    expect(isqrt(1n << 114n)).toBe(1n << 57n);
    expect(isqrt((1n << 57n) * (1n << 57n))).toBe(1n << 57n);
  });

  it("rejects negative input", () => {
    expect(() => isqrt(-1n)).toThrow(RangeError);
  });
});

describe("divCeil", () => {
  it("rounds up only when there is a remainder", () => {
    expect(divCeil(5n, 2n)).toBe(3n);
    expect(divCeil(4n, 2n)).toBe(2n);
    expect(divCeil(0n, 5n)).toBe(0n);
    expect(divCeil(7n, 3n)).toBe(3n);
  });

  it("matches (a + b - 1) / b on small values", () => {
    for (let a = 1n; a <= 50n; a += 1n) {
      for (let b = 1n; b <= 50n; b += 1n) {
        expect(divCeil(a, b)).toBe((a + b - 1n) / b);
      }
    }
  });
});

describe("amountOut", () => {
  it("carves the protocol share out of the LP fee (lp 30 bps, share 12%)", () => {
    // lp_fee = 100000 * 30 / 10000 = 300;  protocol = 300 * 1200 / 10000 = 36.
    // The swapper pays the 30 bps tier; the output ignores the protocol's share.
    expect(amountOut(100_000n, 1_000_000n, 1_000_000n, LP_FEE_BPS, PROTOCOL_FEE_SHARE_BPS)).toEqual({
      amountOut: 90661n,
      reserveInAfter: 1_099_964n,
      reserveOutAfter: 909_339n,
      protocolFee: 36n,
    });

    // Same input with the protocol's share set to nothing: the output and the
    // LP's take are identical, and only the pot is empty.
    expect(amountOut(100_000n, 1_000_000n, 1_000_000n, LP_FEE_BPS, 0n)).toEqual({
      amountOut: 90661n,
      reserveInAfter: 1_100_000n,
      reserveOutAfter: 909_339n,
      protocolFee: 0n,
    });
  });

  it("truncates a share below one base unit", () => {
    // lp_fee = 1000 * 30 / 10000 = 3;  12% of 3 is 0.36, which pays nothing.
    expect(amountOut(1000n, 1_000_000n, 1_000_000n, LP_FEE_BPS, PROTOCOL_FEE_SHARE_BPS).protocolFee).toBe(
      0n,
    );
  });

  it("matches the fee-less invariant", () => {
    expect(amountOut(1000n, 1_000_000n, 1_000_000n, 0n, 0n)).toEqual({
      amountOut: 999n,
      reserveInAfter: 1_001_000n,
      reserveOutAfter: 999_001n,
      protocolFee: 0n,
    });
  });

  it("rejects invalid inputs with the contract error kinds", () => {
    expect(thrownKind(() => amountOut(0n, 1_000_000n, 1_000_000n, 0n, 0n))).toBe("ZeroAmountIn");
    expect(thrownKind(() => amountOut(1000n, 0n, 1_000_000n, 0n, 0n))).toBe("EmptyPool");
    expect(thrownKind(() => amountOut(1n, 1_000_000n, 1_000_000n, LP_FEE_BPS, PROTOCOL_FEE_SHARE_BPS))).toBe(
      "ZeroAmountOut",
    );
    expect(thrownKind(() => amountOut(MAX_AMOUNT + 1n, 1_000_000n, 1_000_000n, 0n, 0n))).toBe(
      "Overflow",
    );
    // reserveInAfter reaches MAX_AMOUNT and reverts.
    expect(thrownKind(() => amountOut(MAX_AMOUNT, 1n, 1000n, 0n, 0n))).toBe("Overflow");
  });

  it("agrees with the reference implementation over a grid", () => {
    const amounts = [1n, 2n, 99n, 1000n, 123_456n, 1_000_000n, MAX_AMOUNT - 1n];
    const reserves = [1n, 1000n, 1_000_000n, MAX_AMOUNT - 1n, MAX_AMOUNT];
    for (const amountIn of amounts) {
      for (const reserveIn of reserves) {
        for (const reserveOut of reserves) {
          const call = () =>
            amountOut(amountIn, reserveIn, reserveOut, LP_FEE_BPS, PROTOCOL_FEE_SHARE_BPS);
          const ref = () =>
            refAmountOut(amountIn, reserveIn, reserveOut, LP_FEE_BPS, PROTOCOL_FEE_SHARE_BPS);
          const actualKind = thrownKind(call);
          const refKind = thrownKind(ref);
          expect(actualKind, `amountOut(${amountIn}, ${reserveIn}, ${reserveOut})`).toBe(refKind);
          if (actualKind === null) {
            expect(call()).toEqual(ref());
          }
        }
      }
    }
  });
});

describe("quoteMint", () => {
  it("first deposit mints sqrt(x*y) - MINIMUM_LIQUIDITY", () => {
    expect(quoteMint(1_000_000n, 1_000_000n, 0n, 0n, 0n)).toEqual({
      liquidityToUser: 1_000_000n - MINIMUM_LIQUIDITY,
      lpSupplyAfter: 1_000_000n,
      reserve0After: 1_000_000n,
      reserve1After: 1_000_000n,
      refund0: 0n,
      refund1: 0n,
    });
  });

  it("later deposit mints the smaller ratio", () => {
    expect(quoteMint(1000n, 1000n, 1_000_000n, 1_000_000n, 1_000_000n)).toEqual({
      liquidityToUser: 1000n,
      lpSupplyAfter: 1_001_000n,
      reserve0After: 1_001_000n,
      reserve1After: 1_001_000n,
      refund0: 0n,
      refund1: 0n,
    });
  });

  it("refunds the excess of the larger side", () => {
    expect(quoteMint(2000n, 1000n, 1_000_000n, 1_000_000n, 1_000_000n)).toEqual({
      liquidityToUser: 1000n,
      lpSupplyAfter: 1_001_000n,
      reserve0After: 1_001_000n,
      reserve1After: 1_001_000n,
      refund0: 1000n,
      refund1: 0n,
    });
  });

  it("rejects invalid inputs with the contract error kinds", () => {
    expect(thrownKind(() => quoteMint(0n, 1000n, 0n, 0n, 0n))).toBe("ZeroAmountIn");
    expect(thrownKind(() => quoteMint(MAX_AMOUNT + 1n, 1000n, 0n, 0n, 0n))).toBe("Overflow");
    // First deposit below MINIMUM_LIQUIDITY.
    expect(thrownKind(() => quoteMint(100n, 100n, 0n, 0n, 0n))).toBe("InsufficientLiquidity");
    // First deposit with non-empty reserves.
    expect(thrownKind(() => quoteMint(1000n, 1000n, 5n, 0n, 0n))).toBe("Invariant");
    // Later deposit with an empty side.
    expect(thrownKind(() => quoteMint(1000n, 1000n, 0n, 1_000_000n, 1_000_000n))).toBe("Invariant");
    // Later deposit that would mint zero LP tokens.
    expect(thrownKind(() => quoteMint(1n, 1n, 1_000_000n, 1_000_000n, 1n))).toBe(
      "InsufficientLiquidity",
    );
    // reserve + amount exceeds MAX_AMOUNT before the ratio branch runs.
    expect(thrownKind(() => quoteMint(1n, 1n, MAX_AMOUNT, MAX_AMOUNT, 1000n))).toBe("Overflow");
  });
});

describe("quoteBurn", () => {
  it("returns the proportional share of both reserves", () => {
    expect(quoteBurn(1000n, 1_000_000n, 1_000_000n, 1_000_000n)).toEqual({
      amount0: 1000n,
      amount1: 1000n,
      lpSupplyAfter: 999_000n,
      reserve0After: 999_000n,
      reserve1After: 999_000n,
    });
  });

  it("rejects invalid inputs with the contract error kinds", () => {
    expect(thrownKind(() => quoteBurn(0n, 1_000_000n, 1_000_000n, 1_000_000n))).toBe(
      "ZeroAmountIn",
    );
    expect(thrownKind(() => quoteBurn(1000n, 0n, 1_000_000n, 1_000_000n))).toBe("EmptyPool");
    expect(thrownKind(() => quoteBurn(MAX_AMOUNT + 1n, 1_000_000n, 1_000_000n, 1_000_000n))).toBe(
      "Overflow",
    );
    // Would leave less than MINIMUM_LIQUIDITY.
    expect(thrownKind(() => quoteBurn(999_001n, 1_000_000n, 1_000_000n, 1_000_000n))).toBe(
      "InsufficientLiquidity",
    );
    // Pays out zero of one side.
    expect(thrownKind(() => quoteBurn(1n, 100n, 100n, 1_000_000n))).toBe("ZeroAmountOut");
  });
});
