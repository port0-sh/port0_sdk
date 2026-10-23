import { describe, expect, it } from "vitest";
import {
  encodeStringWords,
  LP_FAUCET_DECIMALS,
  LP_FAUCET_MAX_SUPPLY,
  lpFaucetSlots,
  lpTokenName,
  lpTokenSymbol,
  symbolFelt,
} from "../src/pool/lpFaucet.js";

describe("lpTokenSymbol", () => {
  it("is PO plus up to five letters of each side", () => {
    expect(lpTokenSymbol("USDCX", "AAA")).toBe("POUSDCXAAA");
    expect(lpTokenSymbol("AAA", "AAB")).toBe("POAAAAAB");
    expect(lpTokenSymbol("ABCDEFGHIJKL", "MNOPQRSTUVWX")).toBe("POABCDEMNOPQ");
    expect(lpTokenSymbol("USDCX", "AAA")).toHaveLength(10);
    expect(lpTokenSymbol("ABCDEFGHIJKL", "MNOPQRSTUVWX")).toHaveLength(12);
  });

  it("drops characters the token alphabet does not allow", () => {
    // Digits are rejected by `TokenSymbol`, so the prefix cannot be `P0`.
    expect(lpTokenSymbol("usdcx", "aaa")).toBe("POUSDCXAAA");
    expect(lpTokenSymbol("US2DCX", "A1A")).toBe("POUSDCXAA");
  });

  it("throws when a side contributes no letters", () => {
    expect(() => lpTokenSymbol("123", "456")).toThrow(/A-Z letter/);
    expect(() => lpTokenSymbol("", "")).toThrow(/A-Z letter/);
  });
});

describe("lpTokenName", () => {
  it("names the pair and stays within 32 bytes", () => {
    expect(lpTokenName("USDCX", "AAA")).toBe("port0 LP USDCX/AAA");
    expect(new TextEncoder().encode(lpTokenName("A".repeat(40), "B".repeat(40))).length).toBe(32);
  });
});

describe("symbolFelt", () => {
  it("is base 26 with the length as the last digit", () => {
    // "A" -> 0 * 26 + 1 = 1; "AA" -> (0 * 26 + 0) * 26 + 2 = 2
    expect(symbolFelt("A")).toBe(1n);
    expect(symbolFelt("AA")).toBe(2n);
    // "B" -> 1 * 26 + 1 = 27
    expect(symbolFelt("B")).toBe(27n);
  });

  it("rejects characters outside A-Z", () => {
    expect(() => symbolFelt("A1")).toThrow(/non A-Z/);
  });
});

describe("encodeStringWords", () => {
  it("writes the length byte, 7 bytes per felt, one word per four felts", () => {
    const words = encodeStringWords("AB", 2);
    // buffer: 02 41 42 00 ... ; felt0 = 0x0000000000424102
    expect(words[0]?.[0]).toBe(0x424102n);
    expect(words[0]?.[1]).toBe(0n);
    expect(words[1]?.every((felt) => felt === 0n)).toBe(true);
  });

  it("packs bytes little-endian inside each 7-byte felt", () => {
    const words = encodeStringWords("1234567", 1);
    // buffer: 07 31 32 33 34 35 36 37 ... (length, then "1234567")
    expect(words[0]?.[0]).toBe(0x36353433323107n);
    expect(words[0]?.[1]).toBe(0x37n);
  });

  it("throws when the value does not fit", () => {
    expect(() => encodeStringWords("A".repeat(64), 2)).toThrow(/does not fit/);
  });
});

describe("lpFaucetSlots", () => {
  it("writes the standards' full layout", () => {
    const slots = lpFaucetSlots("POUSDCXAAA", "port0 LP USDCX/AAA");
    const names = slots.map((slot) => slot.name);
    expect(names).toHaveLength(25);
    expect(names).toContain("miden::standards::faucets::fungible::token_config");
    expect(names).toContain("miden::standards::faucets::token_name_0");
    expect(names).toContain("miden::standards::faucets::token_name_1");
    expect(names).toContain("miden::standards::faucets::mutability_config");
    for (let index = 0; index < 7; index += 1) {
      expect(names).toContain(`miden::standards::faucets::token_description_${index}`);
      expect(names).toContain(`miden::standards::faucets::logo_uri_${index}`);
      expect(names).toContain(`miden::standards::faucets::external_link_${index}`);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("puts supply, max supply, decimals, and the symbol in the config word", () => {
    const slots = lpFaucetSlots("POAAAAAB", "name");
    const config = slots.find((slot) => slot.name.endsWith("fungible::token_config"));
    expect(config?.value).toEqual([
      0n,
      LP_FAUCET_MAX_SUPPLY,
      BigInt(LP_FAUCET_DECIMALS),
      symbolFelt("POAAAAAB"),
    ]);
  });

  it("leaves nothing mutable", () => {
    const slots = lpFaucetSlots("POAAAAAB", "name");
    const mutability = slots.find((slot) => slot.name.endsWith("mutability_config"));
    expect(mutability?.value).toEqual([0n, 0n, 0n, 0n]);
  });
});
