/**
 * Initial storage slot definitions for a fresh pool account.
 *
 * Mirrors `pool_init_storage` in the integration tests: token0/token1 keys and
 * the admin id are seeded at creation; every other slot starts at its zero
 * value and is later set by the admin `configure` call.
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
  admin: AccountIdLike;
}): PoolInitSlotDefinition[] {
  const admin = params.admin;
  return [
    { name: POOL_SLOTS.tokenlpAssetKey, value: null },
    { name: POOL_SLOTS.token0AssetKey, value: params.token0Key },
    { name: POOL_SLOTS.token1AssetKey, value: params.token1Key },
    { name: POOL_SLOTS.lpSupply, value: [0n, 0n, 0n, 0n] },
    { name: POOL_SLOTS.fees, value: null },
    // admin word: [0, 0, suffix, prefix]
    {
      name: POOL_SLOTS.admin,
      value: [0n, 0n, admin.suffix().asInt(), admin.prefix().asInt()],
    },
    { name: POOL_SLOTS.p2idRoot, value: null },
    { name: POOL_SLOTS.protocolPot, value: null },
    { name: POOL_SLOTS.price0CumulativeLast, value: null },
    { name: POOL_SLOTS.price1CumulativeLast, value: null },
    { name: POOL_SLOTS.blockTimestampLast, value: [0n, 0n, 0n, 0n] },
  ];
}
