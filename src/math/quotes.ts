/**
 * Pure TS ports of the pool math in `../miden_xyk/contracts/miden-xyk/src/amm`.
 *
 * Every function mirrors the Rust implementation exactly: same argument order,
 * same rounding (floor division, `div_ceil` for the LP-favouring mint amounts),
 * and the same failure conditions in the same order. Amounts are non-negative
 * `bigint` values bounded by `MAX_AMOUNT` where the contract bounds them.
 */
import {
  FEE_DENOMINATOR,
  MAX_AMOUNT,
  MINIMUM_LIQUIDITY,
} from "../constants.js";

export type PoolMathErrorKind =
  | "EmptyPool"
  | "Overflow"
  | "ZeroAmountIn"
  | "ZeroAmountOut"
  | "InsufficientLiquidity"
  | "Invariant";

const POOL_MATH_ERROR_MESSAGES: Record<PoolMathErrorKind, string> = {
  EmptyPool: "Pool is empty on either or both sides",
  Overflow: "Values would overflow Felt::MAX",
  ZeroAmountIn: "Amount in is zero",
  ZeroAmountOut: "Amount out is zero",
  InsufficientLiquidity: "Not enough liquidity in the pool for the operation",
  Invariant: "Stored reserves and LP supply mismatch",
};

/** Error type thrown by the pure math functions. Mirrors `PoolMathError`. */
export class PoolMathError extends Error {
  readonly kind: PoolMathErrorKind;

  constructor(kind: PoolMathErrorKind) {
    super(POOL_MATH_ERROR_MESSAGES[kind]);
    this.name = "PoolMathError";
    this.kind = kind;
  }
}

export interface Reserves {
  reserve0: bigint;
  reserve1: bigint;
}

export interface SwapQuote {
  amountOut: bigint;
  reserveInAfter: bigint;
  reserveOutAfter: bigint;
  protocolFee: bigint;
}

export interface MintQuote {
  liquidityToUser: bigint;
  lpSupplyAfter: bigint;
  reserve0After: bigint;
  reserve1After: bigint;
  refund0: bigint;
  refund1: bigint;
}

export interface BurnQuote {
  amount0: bigint;
  amount1: bigint;
  lpSupplyAfter: bigint;
  reserve0After: bigint;
  reserve1After: bigint;
}

/** Adds `left + right`, rejecting any sum above `MAX_AMOUNT`. */
function addAmount(left: bigint, right: bigint): bigint {
  const sum = left + right;
  if (sum > MAX_AMOUNT) {
    throw new PoolMathError("Overflow");
  }
  return sum;
}

/**
 * Floor square root of a `u128`-bounded value, ported from `utils/math.rs`.
 * The result always fits in a `u64`.
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) {
    throw new RangeError("isqrt: negative input");
  }
  if (n === 0n) {
    return 0n;
  }
  // Highest set bit index of n, rounded down to an even bit.
  const highestBit = n.toString(2).length - 1;
  let bit = 1n << BigInt(highestBit & ~1);
  let root = 0n;
  let rest = n;
  while (bit !== 0n) {
    const trial = root + bit;
    root >>= 1n;
    if (rest >= trial) {
      rest -= trial;
      root += bit;
    }
    bit >>= 2n;
  }
  return root;
}

/** Ceiling division, ported from `utils/u128.rs::div_ceil`. */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator + (numerator % denominator !== 0n ? 1n : 0n);
}

/**
 * Swap amount-out formula, ported from `amm/swap.rs::amount_out`.
 *
 * The protocol fee is carved out of the LP fee: the swapper pays the LP fee
 * tier, and the output does not depend on the protocol's share. Returns the
 * amount out, the post-swap reserves, and the protocol fee recorded in the pot.
 */
export function amountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  lpFeeBps: bigint,
  protocolFeeShareBps: bigint,
): SwapQuote {
  if (amountIn === 0n) {
    throw new PoolMathError("ZeroAmountIn");
  }
  if (reserveIn === 0n || reserveOut === 0n) {
    throw new PoolMathError("EmptyPool");
  }
  if (amountIn > MAX_AMOUNT || reserveIn > MAX_AMOUNT || reserveOut > MAX_AMOUNT) {
    throw new PoolMathError("Overflow");
  }

  // The protocol is paid out of the LP fee: the swapper pays the LP fee tier,
  // and the output does not depend on the protocol's share.
  const lpFee = (lpFeeBps * amountIn) / FEE_DENOMINATOR;
  const protocolFee = (protocolFeeShareBps * lpFee) / FEE_DENOMINATOR;
  const weight = FEE_DENOMINATOR - lpFeeBps;
  const amountInWithFee = amountIn * weight;

  const denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
  const numerator = amountInWithFee * reserveOut;
  const out = numerator / denominator;

  if (out === 0n) {
    throw new PoolMathError("ZeroAmountOut");
  }
  if (out >= reserveOut) {
    throw new PoolMathError("InsufficientLiquidity");
  }

  // The pool keeps the input minus the protocol's share; that share leaves the
  // pool for the protocol pot.
  const reserveInAfter = reserveIn + (amountIn - protocolFee);
  const reserveOutAfter = reserveOut - out;
  if (reserveInAfter >= MAX_AMOUNT) {
    throw new PoolMathError("Overflow");
  }

  return { amountOut: out, reserveInAfter, reserveOutAfter, protocolFee };
}

/**
 * Liquidity provision quote, ported from `amm/mint.rs::quote_mint`.
 *
 * On the first deposit the pool mints `isqrt(x * y)` LP tokens and retains
 * `MINIMUM_LIQUIDITY` for itself. On later deposits it mints the smaller of the
 * two token-contribution ratios, rounds the consumed token amounts up, and
 * refunds the unused remainder.
 */
export function quoteMint(
  amount0: bigint,
  amount1: bigint,
  reserve0: bigint,
  reserve1: bigint,
  lpSupply: bigint,
): MintQuote {
  if (amount0 === 0n || amount1 === 0n) {
    throw new PoolMathError("ZeroAmountIn");
  }
  if (amount0 > MAX_AMOUNT || amount1 > MAX_AMOUNT || lpSupply > MAX_AMOUNT) {
    throw new PoolMathError("Overflow");
  }

  const reserve0AfterFull = addAmount(reserve0, amount0);
  const reserve1AfterFull = addAmount(reserve1, amount1);

  if (lpSupply === 0n) {
    if (reserve0 !== 0n || reserve1 !== 0n) {
      throw new PoolMathError("Invariant");
    }
    const root = isqrt(reserve0AfterFull * reserve1AfterFull);
    if (root <= MINIMUM_LIQUIDITY) {
      throw new PoolMathError("InsufficientLiquidity");
    }
    return {
      liquidityToUser: root - MINIMUM_LIQUIDITY,
      lpSupplyAfter: root,
      reserve0After: reserve0AfterFull,
      reserve1After: reserve1AfterFull,
      refund0: 0n,
      refund1: 0n,
    };
  }

  if (reserve0 === 0n || reserve1 === 0n) {
    throw new PoolMathError("Invariant");
  }

  const from0 = (amount0 * lpSupply) / reserve0;
  const from1 = (amount1 * lpSupply) / reserve1;
  const liquidity = from0 < from1 ? from0 : from1;
  if (liquidity === 0n) {
    throw new PoolMathError("InsufficientLiquidity");
  }

  const lpSupplyAfter = addAmount(lpSupply, liquidity);
  const amount0Used = divCeil(liquidity * reserve0, lpSupply);
  const amount1Used = divCeil(liquidity * reserve1, lpSupply);
  const reserve0After = addAmount(reserve0, amount0Used);
  const reserve1After = addAmount(reserve1, amount1Used);

  const refund0 = amount0 - amount0Used;
  const refund1 = amount1 - amount1Used;
  if (refund0 < 0n || refund1 < 0n) {
    throw new PoolMathError("Invariant");
  }

  return {
    liquidityToUser: liquidity,
    lpSupplyAfter,
    reserve0After,
    reserve1After,
    refund0,
    refund1,
  };
}

/**
 * Liquidity removal quote, ported from `amm/burn.rs::quote_burn`.
 *
 * Burning `amountToBurn` LP tokens returns the proportional share of both
 * reserves. A burn that would leave less than `MINIMUM_LIQUIDITY` reverts.
 */
export function quoteBurn(
  amountToBurn: bigint,
  reserve0: bigint,
  reserve1: bigint,
  lpSupply: bigint,
): BurnQuote {
  if (amountToBurn === 0n) {
    throw new PoolMathError("ZeroAmountIn");
  }
  if (reserve0 === 0n || reserve1 === 0n || lpSupply === 0n) {
    throw new PoolMathError("EmptyPool");
  }
  if (
    amountToBurn > MAX_AMOUNT ||
    reserve0 > MAX_AMOUNT ||
    reserve1 > MAX_AMOUNT ||
    lpSupply > MAX_AMOUNT
  ) {
    throw new PoolMathError("Overflow");
  }

  const min = lpSupply < MINIMUM_LIQUIDITY ? lpSupply : MINIMUM_LIQUIDITY;
  if (amountToBurn > lpSupply - min) {
    throw new PoolMathError("InsufficientLiquidity");
  }

  const amount0 = (amountToBurn * reserve0) / lpSupply;
  const amount1 = (amountToBurn * reserve1) / lpSupply;
  if (amount0 === 0n || amount1 === 0n) {
    throw new PoolMathError("ZeroAmountOut");
  }

  return {
    amount0,
    amount1,
    lpSupplyAfter: lpSupply - amountToBurn,
    reserve0After: reserve0 - amount0,
    reserve1After: reserve1 - amount1,
  };
}
