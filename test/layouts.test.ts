import { describe, expect, it } from "vitest";
import {
  registryCollectNoteStorage,
  burnNoteStorage,
  collectNoteStorage,
  mintNoteStorage,
  registerNoteStorage,
  swapNoteStorage,
} from "../src/notes/layouts.js";
import type { AccountIdLike } from "../src/math/encoding.js";

function id(prefix: bigint, suffix: bigint): AccountIdLike {
  return {
    prefix: () => ({ asInt: () => prefix }),
    suffix: () => ({ asInt: () => suffix }),
  };
}

const pool = id(0xa1n, 0xa2n);
const recipient = id(0xb1n, 0xb2n);
const serial = [1n, 2n, 3n, 4n] as const;
const tag = 5n;
const deadline = 6n;

describe("note storage layouts", () => {
  it("mint: pool, recipient, serial, tag, deadline, min_lp_out (11 felts)", () => {
    const felts = mintNoteStorage({
      poolId: pool,
      recipient,
      serial,
      tag,
      deadline,
      minLpOut: 7n,
    });
    expect(felts).toHaveLength(11);
    expect(felts).toEqual([0xa1n, 0xa2n, 0xb1n, 0xb2n, 1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  });

  it("burn: pool, recipient, serial, tag, deadline, min0, min1 (12 felts)", () => {
    const felts = burnNoteStorage({
      poolId: pool,
      recipient,
      serial,
      tag,
      deadline,
      minAmount0: 7n,
      minAmount1: 8n,
    });
    expect(felts).toHaveLength(12);
    expect(felts).toEqual([
      0xa1n, 0xa2n, 0xb1n, 0xb2n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n,
    ]);
  });

  it("swap: pool, recipient, serial, tag, deadline, min_amount_out (11 felts)", () => {
    const felts = swapNoteStorage({
      poolId: pool,
      recipient,
      serial,
      tag,
      deadline,
      minAmountOut: 9n,
    });
    expect(felts).toHaveLength(11);
    expect(felts).toEqual([0xa1n, 0xa2n, 0xb1n, 0xb2n, 1n, 2n, 3n, 4n, 5n, 6n, 9n]);
  });

  it("collect: pool, serial, then one asset key per sweep (6 + 4n felts)", () => {
    const key0 = [7n, 8n, 9n, 10n] as const;
    const key1 = [11n, 12n, 13n, 14n] as const;
    expect(
      collectNoteStorage({ poolId: pool, serial, assetKeys: [key0, key1] }),
    ).toEqual([0xa1n, 0xa2n, 1n, 2n, 3n, 4n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n]);
  });

  it("register: registry, pool, asset0, asset1 (8 felts)", () => {
    const registry = id(0xd1n, 0xd2n);
    const asset0 = id(0xe1n, 0xe2n);
    const asset1 = id(0xf1n, 0xf2n);
    const felts = registerNoteStorage({
      registryId: registry,
      poolId: pool,
      asset0,
      asset1,
    });
    expect(felts).toHaveLength(8);
    expect(felts).toEqual([
      0xd1n, 0xd2n, 0xa1n, 0xa2n, 0xe1n, 0xe2n, 0xf1n, 0xf2n,
    ]);
  });

  it("registry-collect: registry, serial, then one asset key per sweep (6 + 4n felts)", () => {
    const registry = id(0xa1n, 0xa2n);
    const assetKey = [1n, 2n, 3n, 4n] as const;
    const serial = [5n, 6n, 7n, 8n] as const;
    const felts = registryCollectNoteStorage({ registryId: registry, serial, assetKeys: [assetKey] });
    expect(felts).toHaveLength(10);
    expect(felts).toEqual([
      0xa1n, 0xa2n, 5n, 6n, 7n, 8n, 1n, 2n, 3n, 4n,
    ]);
  });
});
