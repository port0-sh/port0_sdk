/**
 * Initial storage slot definitions for a fresh pool account.
 *
 * Mirrors `pool_init_storage` in the integration tests. Everything except the
 * LP token key is seeded at creation: the key is derived by the contract from
 * the pool's own account id, which cannot be known before the account exists.
 */
import { POOL_SLOTS } from "../constants.js";
import type { AccountIdLike, Word4 } from "../math/encoding.js";

export interface PoolInitSlotDefinition {
  name: string;
  /** Value word, or null for an empty value slot. */
  value: Word4 | null;
}

export function poolInitSlots(params: {
  token0Key: Word4;
  token1Key: Word4;
  registryId: AccountIdLike;
  lpFeeBps: bigint;
  protocolFeeShareBps: bigint;
  p2idRoot: Word4;
}): PoolInitSlotDefinition[] {
  const registry = params.registryId;
  return [
    { name: POOL_SLOTS.token0AssetKey, value: params.token0Key },
    { name: POOL_SLOTS.token1AssetKey, value: params.token1Key },
    { name: POOL_SLOTS.lpSupply, value: [0n, 0n, 0n, 0n] },
    { name: POOL_SLOTS.reserves, value: [0n, 0n, 0n, 0n] },
    // fees word: [lp_fee_bps, protocol_fee_share_bps, 0, 0]
    {
      name: POOL_SLOTS.fees,
      value: [params.lpFeeBps, params.protocolFeeShareBps, 0n, 0n],
    },
    { name: POOL_SLOTS.p2idRoot, value: params.p2idRoot },
    { name: POOL_SLOTS.protocolPot, value: null },
    { name: POOL_SLOTS.price0CumulativeLast, value: null },
    { name: POOL_SLOTS.price1CumulativeLast, value: null },
    { name: POOL_SLOTS.blockTimestampLast, value: [0n, 0n, 0n, 0n] },
    // registry id word: [0, 0, suffix, prefix]
    {
      name: POOL_SLOTS.registryId,
      value: [0n, 0n, registry.suffix().asInt(), registry.prefix().asInt()],
    },
  ];
}
