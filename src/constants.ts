/**
 * Contract-level constants mirrored from the `port0` contracts
 * workspace.
 *
 * These are part of the XYK ABI: the pool component reads and writes the same
 * slot names on-chain, and the math constants bound every amount accepted by
 * the pool procedures. Change them only together with a contract change and a
 * regeneration of `src/generated/contracts.ts`.
 */

import type { NoteKind } from "./notes/scripts.js";

/** Upper bound on every reserve, amount, and `lp_supply` (see `utils/math.rs`). */
export const MAX_AMOUNT: bigint = 1n << 57n;

/** LP tokens locked permanently on the first mint. */
export const MINIMUM_LIQUIDITY: bigint = 1000n;

/** Basis-point denominator for both fee components. */
export const FEE_DENOMINATOR: bigint = 10_000n;

/**
 * Operator-solvency ceiling, in fee-asset base units.
 *
 * The kernel charges `verification_base_fee * (ilog2(total_cycles) + 1)` and caps a transaction at
 * `MAX_TX_EXECUTION_CYCLES = 2^29`, so the maximum is `base_fee * 30`. On the 0.17 testnet the
 * base fee is 7, giving 210. Scripts use it to size an operator's funding, never as a note price:
 * the surplus stays with the operator. Note sponsorships use `NOTE_FEES`.
 */
export const MAX_TX_FEE: bigint = 210n;

/**
 * Schedule price per note kind, in fee-asset base units.
 *
 * Measured by `cargo test -p integration --release note_fee_benchmark` on a
 * MockChain network-account transaction at verification base fee 7, the 0.17
 * testnet value. Each price is the kernel fee for the most expensive measured
 * path plus the `NetworkNotePricer` margin of one verification cycle (7 base
 * units). The pool and registry fee schedules store these values, and an
 * emitter's sponsorship equals the schedule entry for its note kind.
 *
 * Regenerate the table when a note script changes its cycle count; a root
 * change alone does not change the price. The collect scripts cap a note at
 * four asset keys, which is the key count these prices cover.
 */
export const NOTE_FEES: Record<NoteKind, bigint> = {
  mint: 126n,
  burn: 126n,
  swap: 126n,
  collect: 126n,
  register: 119n,
  "registry-collect": 119n,
  // The admin's config note: the registry pays its own fee from accumulated
  // register fees, so a price change costs the admin nothing.
  "registry-config": 0n,
};

/**
 * Storage slot name prefix shared by every `port0` component slot.
 *
 * Slot names are `<package_name>::<interface_segment>::<field_name>`; the
 * package name is `port0` and the interface segment is `port0`, both
 * sanitised to `port0`. Mirrors `integration/tests/port0_test.rs`.
 */
export const SLOT_PREFIX = "port0::port0";

/** The 11 value slots declared by `Port0Storage`. */
export const POOL_SLOTS = {
  token0AssetKey: `${SLOT_PREFIX}::token0_asset_key`,
  token1AssetKey: `${SLOT_PREFIX}::token1_asset_key`,
  lpSupply: `${SLOT_PREFIX}::lp_supply`,
  /** Stored accounting the vault must cover: `[reserve0, reserve1, 0, 0]`. */
  reserves: `${SLOT_PREFIX}::reserves`,
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
  expectedNoteAllowlistRoot: `${REGISTRY_SLOT_PREFIX}::expected_note_allowlist_root`,
  expectedTxScriptAllowlistRoot: `${REGISTRY_SLOT_PREFIX}::expected_tx_script_allowlist_root`,
  expectedFeeScheduleRoot: `${REGISTRY_SLOT_PREFIX}::expected_fee_schedule_root`,
  expectedFeeAssetId: `${REGISTRY_SLOT_PREFIX}::expected_fee_asset_id`,
  expectedActiveFeePolicyRoot: `${REGISTRY_SLOT_PREFIX}::expected_active_fee_policy_root`,
  expectedAllowedFeePolicyRoots: `${REGISTRY_SLOT_PREFIX}::expected_allowed_fee_policy_roots`,
  admin: `${REGISTRY_SLOT_PREFIX}::admin`,
  registerNoteRoot: `${REGISTRY_SLOT_PREFIX}::register_note_root`,
} as const;

/**
 * Slot names of the pool's auth component, in the order `get_auth_identity`
 * returns their roots. The registry compares the pool's roots against the ones
 * it was created with, because the code commitment pins code, not storage.
 */
export const POOL_AUTH_SLOTS = {
  noteAllowlistRoot: "miden::standards::auth::network_account::allowed_note_scripts",
  txScriptAllowlistRoot: "miden::standards::auth::network_account::allowed_tx_scripts",
  feeScheduleRoot: "miden::standards::fees::policies::basic_constant_fee::fee_schedule",
  feeAssetId: "miden::standards::auth::network_account::fee_asset_id",
  activeFeePolicyRoot: "miden::standards::auth::network_account::active_fee_policy_proc_root",
  allowedFeePolicyRoots: "miden::standards::auth::network_account::allowed_fee_policy_proc_roots",
} as const;
