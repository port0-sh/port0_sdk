/**
 * Pure helpers shared by the high-level operations.
 */
import { FEE_DENOMINATOR } from "../constants.js";
import { XykError } from "../errors.js";

/**
 * Applies a basis-point slippage bound: the minimum acceptable output for a
 * quoted amount. `slippageBps` is in [0, 10000); 50 means "at most 0.5% worse".
 */
export function applySlippage(amount: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps >= FEE_DENOMINATOR) {
    throw new XykError(
      "INVALID_ARGUMENT",
      `slippageBps must be in [0, ${FEE_DENOMINATOR})`,
    );
  }
  return (amount * (FEE_DENOMINATOR - slippageBps)) / FEE_DENOMINATOR;
}

/**
 * Resolves which pool side `tokenIn` is on. Ids are canonical account-id hex
 * strings (from `AccountId.toString()`). Returns 0 for token0, 1 for token1.
 */
export function resolveSwapSide(
  tokenIn: string,
  token0: string,
  token1: string,
): 0 | 1 {
  if (tokenIn === token0) {
    return 0;
  }
  if (tokenIn === token1) {
    return 1;
  }
  throw new XykError("INVALID_ARGUMENT", "tokenIn matches neither token0 nor token1");
}

/** A block timestamp plus a margin, used as a note deadline. */
export function deadlineFrom(
  blockTimestampSeconds: bigint,
  marginSeconds: bigint,
): bigint {
  return blockTimestampSeconds + marginSeconds;
}
