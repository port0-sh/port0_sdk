#!/usr/bin/env node
/**
 * Prints the pool account code commitment.
 *
 * This is the value the registry's `accepted_code_commitments` map must hold.
 * It is computed by building the pool through the SDK's own `buildPoolAccount`
 * path, so it cannot drift from a deployed pool. The account seed and the
 * storage values do not affect the code commitment; dummy accounts supply the
 * required ids.
 *
 * Run after build:
 *   npm run build && node scripts/pool-code-commitment.mjs
 */
import { FaucetType, MidenClient } from "@miden-sdk/miden-sdk";
import { fungibleAssetIdWord, poolCodeCommitment } from "../dist/index.js";

const client = await MidenClient.createMock();

const registry = (await client.accounts.create({ storage: "public" })).id();
const token0 = (
  await client.accounts.create({
    type: FaucetType.FungibleFaucet,
    symbol: "ALPHA",
    decimals: 8,
    maxSupply: 1_000_000_000n,
    storage: "public",
  })
).id();
const token1 = (
  await client.accounts.create({
    type: FaucetType.FungibleFaucet,
    symbol: "BETA",
    decimals: 8,
    maxSupply: 1_000_000_000n,
    storage: "public",
  })
).id();
const feeFaucet = (
  await client.accounts.create({
    type: FaucetType.FungibleFaucet,
    symbol: "FEE",
    decimals: 8,
    maxSupply: 1_000_000_000n,
    storage: "public",
  })
).id();

// The commitment is over code only, so the fee and registry values here do not
// affect it; they only have to satisfy the account builder.
const commitment = await poolCodeCommitment(client, {
  token0Key: fungibleAssetIdWord(token0),
  token1Key: fungibleAssetIdWord(token1),
  registryId: registry,
  lpFeeBps: 30n,
  protocolFeeShareBps: 10n,
  feeFaucetId: feeFaucet,
});

console.log(commitment);
