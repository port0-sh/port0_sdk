import { describe, expect, it } from "vitest";
import {
  accountIdFelts,
  accountTargetTag,
  fungibleAssetIdWord,
  isWord4,
  randomSerial,
  type AccountIdLike,
} from "../src/math/encoding.js";

function id(prefix: bigint, suffix: bigint): AccountIdLike {
  return {
    prefix: () => ({ asInt: () => prefix }),
    suffix: () => ({ asInt: () => suffix }),
  };
}

describe("accountIdFelts", () => {
  it("encodes prefix first, then suffix", () => {
    expect(accountIdFelts(id(0x0102030405060708n, 0x1112131415161718n))).toEqual([
      0x0102030405060708n,
      0x1112131415161718n,
    ]);
  });
});

describe("fungibleAssetIdWord", () => {
  it("derives the asset id word with the 0x11 metadata byte", () => {
    // suffix lower 8 bits are zero for a valid faucet id.
    const suffix = 0x0011223344556600n;
    const prefix = 0x0102030405060708n;
    expect(fungibleAssetIdWord(id(prefix, suffix))).toEqual([
      0n,
      0n,
      suffix | 0x11n,
      prefix,
    ]);
  });
});

describe("accountTargetTag", () => {
  it("keeps the top 14 prefix bits and zeroes the rest", () => {
    // prefix >> 32 = 0x3FFFABCD; masked with 0xFFFC0000 -> 0x3FFC0000.
    expect(accountTargetTag(id(0x3fffabcd_12345678n, 0n))).toBe(0x3ffc0000n);
  });

  it("never produces a negative tag when bit 31 of the prefix is set", () => {
    // prefix >> 32 = 0xFFFFFFFF (bit 31 set) -> tag stays in [0, 2^32).
    expect(accountTargetTag(id(0xffffffff_00000000n, 0n))).toBe(0xfffc0000n);
  });
});

describe("randomSerial", () => {
  it("returns four non-negative limbs below 2^63", () => {
    for (let i = 0; i < 32; i += 1) {
      const serial = randomSerial();
      expect(serial).toHaveLength(4);
      for (const limb of serial) {
        expect(limb).toBeGreaterThanOrEqual(0n);
        expect(limb).toBeLessThan(1n << 63n);
      }
    }
  });
});

describe("isWord4", () => {
  it("accepts only four canonical field-element limbs", () => {
    expect(isWord4([0n, 0n, 0n, 0n])).toBe(true);
    expect(isWord4([1n << 64n, 0n, 0n, 0n])).toBe(false);
    expect(isWord4([0n, 0n, 0n])).toBe(false);
    expect(isWord4([0n, 0n, 0n, 0n, 0n])).toBe(false);
    expect(isWord4([-1n, 0n, 0n, 0n])).toBe(false);
  });
});
