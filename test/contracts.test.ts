import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { contractPackageBytes, CONTRACT_KINDS } from "../src/artifacts.js";
import { CONTRACT_SHA256 } from "../src/generated/contracts.js";
import {
  FEE_DENOMINATOR,
  MAX_AMOUNT,
  MINIMUM_LIQUIDITY,
  POOL_SLOTS,
} from "../src/constants.js";

describe("generated contract artifacts", () => {
  it("ships a non-empty package for every contract kind", () => {
    for (const kind of CONTRACT_KINDS) {
      const bytes = contractPackageBytes(kind);
      expect(bytes.length, `${kind} package must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("matches the recorded SHA-256 of each package", () => {
    for (const kind of CONTRACT_KINDS) {
      const digest = createHash("sha256")
        .update(contractPackageBytes(kind))
        .digest("hex");
      expect(digest, `${kind} sha256 drift`).toBe(CONTRACT_SHA256[kind]);
    }
  });
});

describe("pool constants", () => {
  it("mirrors the contract math bounds", () => {
    expect(MAX_AMOUNT).toBe(1n << 57n);
    expect(MINIMUM_LIQUIDITY).toBe(1000n);
    expect(FEE_DENOMINATOR).toBe(10_000n);
  });

  it("declares the 11 pool storage slot names", () => {
    expect(Object.values(POOL_SLOTS)).toEqual([
      "miden_xyk::miden_xyk::tokenlp_asset_key",
      "miden_xyk::miden_xyk::token0_asset_key",
      "miden_xyk::miden_xyk::token1_asset_key",
      "miden_xyk::miden_xyk::lp_supply",
      "miden_xyk::miden_xyk::fees",
      "miden_xyk::miden_xyk::admin",
      "miden_xyk::miden_xyk::p2id_root",
      "miden_xyk::miden_xyk::protocol_pot",
      "miden_xyk::miden_xyk::price0_cumulative_last",
      "miden_xyk::miden_xyk::price1_cumulative_last",
      "miden_xyk::miden_xyk::block_timestamp_last",
    ]);
  });
});
