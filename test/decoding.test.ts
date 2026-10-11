import { describe, expect, it } from "vitest";
import {
  assetKeyToFaucetIdFelts,
  decodeAccountIdWord,
  decodeFeesWord,
  decodeProtocolPotWord,
  decodeScalarWord,
  decodeU128Word,
  isZeroWord4,
} from "../src/pool/decoding.js";

describe("pool storage word decoders", () => {
  it("decodes the fees word", () => {
    // The fee recipient is not in this word any more: the registry holds it.
    expect(decodeFeesWord([30n, 10n, 0n, 0n])).toEqual({
      lpFeeBps: 30n,
      protocolFeeShareBps: 10n,
    });
  });

  it("decodes an account id word [0,0,suffix,prefix]", () => {
    expect(decodeAccountIdWord([0n, 0n, 0xa2n, 0xa1n])).toEqual([0xa1n, 0xa2n]);
  });

  it("decodes scalar words [value,0,0,0]", () => {
    expect(decodeScalarWord([123n, 0n, 0n, 0n])).toBe(123n);
  });

  it("decodes the protocol pot word [amount0,amount1,0,0]", () => {
    expect(decodeProtocolPotWord([7n, 8n, 0n, 0n])).toEqual({
      amount0: 7n,
      amount1: 8n,
    });
  });

  it("decodes u128 little-endian 32-bit limbs", () => {
    expect(decodeU128Word([0xffffffffn, 0x1n, 0n, 0n])).toBe(0x1_ffffffffn);
    expect(
      decodeU128Word([0xaaaaaaaan, 0xbbbbbbbbn, 0xccccccccn, 0xddddddddn]),
    ).toBe(0xdddddddd_cccccccc_bbbbbbbb_aaaaaaaan);
  });

  it("detects the zero word", () => {
    expect(isZeroWord4([0n, 0n, 0n, 0n])).toBe(true);
    expect(isZeroWord4([0n, 0n, 0n, 1n])).toBe(false);
  });

  it("recovers the faucet id from a fungible asset key", () => {
    // [0, 0, suffix | 0x11, prefix] -> [prefix, suffix]
    expect(
      assetKeyToFaucetIdFelts([0n, 0n, 0x0011223344556611n, 0x0102030405060708n]),
    ).toEqual([0x0102030405060708n, 0x0011223344556600n]);
  });
});
