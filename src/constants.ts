/**
 * Contract-level constants mirrored from `../miden_xyk`.
 *
 * These are part of the XYK ABI: the pool component reads and writes the same
 * slot names on-chain, and the math constants bound every amount accepted by
 * the pool procedures. Change them only together with a contract change and a
 * regeneration of `src/generated/contracts.ts`.
 */

/** Upper bound on every reserve, amount, and `lp_supply` (see `utils/math.rs`). */
export const MAX_AMOUNT: bigint = 1n << 57n;

/** LP tokens locked permanently on the first mint. */
export const MINIMUM_LIQUIDITY: bigint = 1000n;

/** Basis-point denominator for both fee components. */
export const FEE_DENOMINATOR: bigint = 10_000n;

/**
 * Storage slot name prefix shared by every `miden-xyk` component slot.
 *
 * Slot names are `<package_name>::<interface_segment>::<field_name>`; the
 * package name is `miden-xyk` and the interface segment is `miden-xyk`, both
 * sanitised to `miden_xyk`. Mirrors `integration/tests/miden_xyk_test.rs`.
 */
export const SLOT_PREFIX = "miden_xyk::miden_xyk";

/** The 10 value slots declared by `MidenXykStorage`. */
export const POOL_SLOTS = {
  token0AssetKey: `${SLOT_PREFIX}::token0_asset_key`,
  token1AssetKey: `${SLOT_PREFIX}::token1_asset_key`,
  lpSupply: `${SLOT_PREFIX}::lp_supply`,
  fees: `${SLOT_PREFIX}::fees`,
  p2idRoot: `${SLOT_PREFIX}::p2id_root`,
  protocolPot: `${SLOT_PREFIX}::protocol_pot`,
  price0CumulativeLast: `${SLOT_PREFIX}::price0_cumulative_last`,
  price1CumulativeLast: `${SLOT_PREFIX}::price1_cumulative_last`,
  blockTimestampLast: `${SLOT_PREFIX}::block_timestamp_last`,
  registryId: `${SLOT_PREFIX}::registry_id`,
} as const;

export type PoolSlotName = (typeof POOL_SLOTS)[keyof typeof POOL_SLOTS];

/** Registry slot prefix, mirroring `contracts/pool-registry`. */
export const REGISTRY_SLOT_PREFIX = "pool_registry::pool_registry";

/** The registry's value slots and maps. */
export const REGISTRY_SLOTS = {
  acceptedCodeCommitments: `${REGISTRY_SLOT_PREFIX}::accepted_code_commitments`,
  pools: `${REGISTRY_SLOT_PREFIX}::pools`,
  assetsToPool: `${REGISTRY_SLOT_PREFIX}::assets_to_pool`,
  protocolFeeTo: `${REGISTRY_SLOT_PREFIX}::protocol_fee_to`,
  protocolFeeShareBps: `${REGISTRY_SLOT_PREFIX}::protocol_fee_share_bps`,
  allowedLpFeeBps: `${REGISTRY_SLOT_PREFIX}::allowed_lp_fee_bps`,
  p2idRoot: `${REGISTRY_SLOT_PREFIX}::p2id_root`,
} as const;
