import { describe, expect, it } from "vitest";
import { poolInitSlots } from "../src/pool/slots.js";
import { POOL_SLOTS } from "../src/constants.js";
import type { AccountIdLike } from "../src/math/encoding.js";

function id(prefix: bigint, suffix: bigint): AccountIdLike {
  return {
    prefix: () => ({ asInt: () => prefix }),
    suffix: () => ({ asInt: () => suffix }),
  };
}

const token0Key = [1n, 2n, 3n, 4n] as const;
const token1Key = [5n, 6n, 7n, 8n] as const;

describe("poolInitSlots", () => {
  it("declares all 10 slots with the creation-time values", () => {
    const slots = poolInitSlots({
      token0Key,
      token1Key,
      registryId: id(0xa1n, 0xa2n),
      lpFeeBps: 30n,
      protocolFeeShareBps: 10n,
      p2idRoot: [10n, 11n, 12n, 13n],
    });

    expect(slots.map((s) => s.name)).toEqual([
      POOL_SLOTS.token0AssetKey,
      POOL_SLOTS.token1AssetKey,
      POOL_SLOTS.lpSupply,
      POOL_SLOTS.fees,
      POOL_SLOTS.p2idRoot,
      POOL_SLOTS.protocolPot,
      POOL_SLOTS.price0CumulativeLast,
      POOL_SLOTS.price1CumulativeLast,
      POOL_SLOTS.blockTimestampLast,
      POOL_SLOTS.registryId,
    ]);

    // token0/token1 keys and the fee word are seeded; registry_id is
    // [0, 0, suffix, prefix].
    expect(slots[0]?.value).toEqual([1n, 2n, 3n, 4n]);
    expect(slots[1]?.value).toEqual([5n, 6n, 7n, 8n]);
    expect(slots[3]?.value).toEqual([30n, 10n, 0n, 0n]);
    expect(slots[9]?.value).toEqual([0n, 0n, 0xa2n, 0xa1n]);

    // lp_supply and block_timestamp_last start at zero; the pot and the two
    // cumulative prices start empty.
    expect(slots[2]?.value).toEqual([0n, 0n, 0n, 0n]);
    expect(slots[8]?.value).toEqual([0n, 0n, 0n, 0n]);
    for (const index of [5, 6, 7]) {
      expect(slots[index]?.value, `slot ${index}`).toBeNull();
    }
  });
});
