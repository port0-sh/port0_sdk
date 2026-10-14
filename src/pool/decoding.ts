/**
 * Pure decoders for the pool's storage words.
 *
 * The pool stores eleven value slots; several encode structured data inside a
 * single word. These functions take a four-limb word (`Word4`) and return the
 * decoded fields without touching WASM, so the layouts are unit-testable
 * against the contract's storage table.
 */
import type { Word4 } from "../math/encoding.js";

/**
 * `fees` word: `[lp_fee_bps, protocol_fee_share_bps, 0, 0]`.
 *
 * The protocol's fee destination is not here: it lives on the registry, and a
 * pool reads it only when it collects.
 */
export function decodeFeesWord(word: Word4): {
  lpFeeBps: bigint;
  protocolFeeShareBps: bigint;
} {
  return {
    lpFeeBps: word[0],
    protocolFeeShareBps: word[1],
  };
}

/**
 * An account id stored as `[0, 0, suffix, prefix]`, the layout the contract
 * uses for `registry_id`. Returns `[prefix, suffix]`.
 */
export function decodeAccountIdWord(word: Word4): [bigint, bigint] {
  return [word[3], word[2]];
}

/** `lp_supply` / `block_timestamp_last` word: `[value, 0, 0, 0]`. */
export function decodeScalarWord(word: Word4): bigint {
  return word[0];
}

/** `reserves` word: `[reserve0, reserve1, 0, 0]`. */
export function decodeReservesWord(word: Word4): {
  reserve0: bigint;
  reserve1: bigint;
} {
  return { reserve0: word[0], reserve1: word[1] };
}

/** `protocol_pot` word: `[amount0, amount1, 0, 0]`. */
export function decodeProtocolPotWord(word: Word4): {
  amount0: bigint;
  amount1: bigint;
} {
  return { amount0: word[0], amount1: word[1] };
}

/**
 * `price*_cumulative_last` word: a `u128` stored as four little-endian 32-bit
 * limbs.
 */
export function decodeU128Word(word: Word4): bigint {
  return word[0] | (word[1] << 32n) | (word[2] << 64n) | (word[3] << 96n);
}

export function isZeroWord4(word: Word4): boolean {
  return word[0] === 0n && word[1] === 0n && word[2] === 0n && word[3] === 0n;
}

/**
 * Recovers the issuing faucet id `[prefix, suffix]` from a fungible asset key
 * word `[0, 0, faucet_suffix | 0x11, faucet_prefix]`.
 */
export function assetKeyToFaucetIdFelts(key: Word4): [bigint, bigint] {
  return [key[3], key[2] & ~0xffn];
}
