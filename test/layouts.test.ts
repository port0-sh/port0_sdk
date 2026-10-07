import { describe, expect, it } from "vitest";
import {
  adminNoteStorage,
  burnNoteStorage,
  collectNoteStorage,
  mintNoteStorage,
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

  it("collect: serial only (4 felts)", () => {
    expect(collectNoteStorage(serial)).toEqual([1n, 2n, 3n, 4n]);
  });

  it("admin: pool, fee_to, fees, p2id root, lp key (14 felts)", () => {
    const feeTo = id(0xc1n, 0xc2n);
    const p2idRoot = [10n, 11n, 12n, 13n] as const;
    const lpKey = [14n, 15n, 16n, 17n] as const;
    const felts = adminNoteStorage({
      poolId: pool,
      feeTo,
      lpFeeBps: 30n,
      protocolFeeBps: 10n,
      p2idRoot,
      lpKey,
    });
    expect(felts).toHaveLength(14);
    expect(felts).toEqual([
      0xa1n, 0xa2n, 0xc1n, 0xc2n, 30n, 10n, 10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n,
    ]);
  });
});
