/**
 * Pure decoders for the pool's storage words.
 *
 * The pool stores eleven value slots; several encode structured data inside a
 * single word. These functions take a four-limb word (`Word4`) and return the
 * decoded fields without touching WASM, so the layouts are unit-testable
 * against the contract's storage table.
 */
import type { Word4 } from "../math/encoding.js";

/** `fees` word: `[lp_fee_bps, protocol_fee_bps, fee_to.prefix, fee_to.suffix]`. */
export function decodeFeesWord(word: Word4): {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  feeTo: [bigint, bigint]; // [prefix, suffix]
} {
  return {
    lpFeeBps: word[0],
    protocolFeeBps: word[1],
    feeTo: [word[2], word[3]],
  };
}

/** `admin` word: `[0, 0, suffix, prefix]`. Returns `[prefix, suffix]`. */
export function decodeAdminWord(word: Word4): [bigint, bigint] {
  return [word[3], word[2]];
}

/** `lp_supply` / `block_timestamp_last` word: `[value, 0, 0, 0]`. */
export function decodeScalarWord(word: Word4): bigint {
  return word[0];
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
