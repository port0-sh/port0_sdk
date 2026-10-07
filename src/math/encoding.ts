/**
 * Encoders for the felt layouts the XYK note scripts read from note storage.
 *
 * Account ids are two felts in the order `[prefix, suffix]` (the note scripts
 * call `AccountId::new(storage[0], storage[1])`). Asset keys and account
 * target tags use the exact bit layouts the protocol and the pool component
 * derive on-chain.
 *
 * The account-id helpers accept a structural type so they can be unit-tested
 * without initialising the WASM module; the web-sdk `AccountId` satisfies it.
 */

/** Structural subset of the web-sdk `AccountId` used by the encoders. */
export interface AccountIdLike {
  prefix(): { asInt(): bigint };
  suffix(): { asInt(): bigint };
}

/** A note serial number: four field elements. */
export type SerialNumber = readonly [bigint, bigint, bigint, bigint];

/** An asset key / word: four field elements. */
export type Word4 = readonly [bigint, bigint, bigint, bigint];

/** Number of high prefix bits used for an account-target note tag. */
export const ACCOUNT_TARGET_TAG_LEN = 14;

/** The metadata byte for a fungible asset id: composition 1, version 1. */
const FUNGIBLE_ASSET_METADATA = 0x11n;

/**
 * Encodes an account id as `[prefix, suffix]`, the order the note scripts
 * pass to `AccountId::new`.
 */
export function accountIdFelts(id: AccountIdLike): [bigint, bigint] {
  return [id.prefix().asInt(), id.suffix().asInt()];
}

/**
 * Derives the fungible asset id word for an asset issued by `faucetId`.
 *
 * Mirrors `miden_protocol::asset::AssetId::to_word` for a default-class
 * fungible asset: `[0, 0, faucet_suffix | metadata, faucet_prefix]`, where the
 * metadata byte is `0x11` (composition 1, version 1). The lower 8 bits of a
 * valid faucet suffix are zero, so the OR is exact.
 */
export function fungibleAssetIdWord(faucetId: AccountIdLike): Word4 {
  const suffix = faucetId.suffix().asInt();
  const prefix = faucetId.prefix().asInt();
  return [0n, 0n, suffix | FUNGIBLE_ASSET_METADATA, prefix];
}

/**
 * The account-target note tag: the top 14 bits of the account id prefix's
 * high 32 bits, lower bits zeroed. Mirrors the contract's
 * `utils/note.rs::account_target_tag` and `NoteTag::with_account_target`.
 *
 * Computed entirely in `bigint`; using JS `<<`/`&` on `number` would truncate
 * to int32 and produce a negative tag whenever bit 31 of the prefix is set.
 */
export function accountTargetTag(id: AccountIdLike): bigint {
  const prefix = id.prefix().asInt();
  const high = (prefix >> 32n) & 0xffff_ffffn;
  const mask =
    (0xffff_ffffn << BigInt(32 - ACCOUNT_TARGET_TAG_LEN)) & 0xffff_ffffn;
  return high & mask;
}

/**
 * Draws a random serial number of four field elements.
 *
 * Each limb is a random `u64` shifted right by one so the value is below the
 * Goldilocks field modulus; this is the same construction used to generate
 * note serials without reduction.
 */
export function randomSerial(): SerialNumber {
  const raw = new BigUint64Array(4);
  crypto.getRandomValues(raw);
  return [raw[0]! >> 1n, raw[1]! >> 1n, raw[2]! >> 1n, raw[3]! >> 1n];
}

/** Draws 32 cryptographically random bytes, usable as an account seed. */
export function randomSeed(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** True when a value is a canonical 4-limb field-element word (each < 2^64). */
export function isWord4(value: readonly bigint[]): value is Word4 {
  return (
    value.length === 4 &&
    value.every((limb) => limb >= 0n && limb < 1n << 64n)
  );
}
