/**
 * WASM runtime smoke test, run as a plain Node process (not vitest) because the
 * web-sdk native module is unreliable inside vitest's worker pool.
 *
 * Run with: npm run build && node test/wasm-smoke.mjs
 */
import assert from "node:assert/strict";
import {
  AccountComponent,
  FaucetType,
  MidenClient,
  NoteScript,
  Package,
  StorageSlot,
} from "@miden-sdk/miden-sdk";
import {
  buildAdminNote,
  buildBurnNote,
  buildCollectNote,
  buildFeeSponsorshipNote,
  buildMintNote,
  buildSwapNote,
  contractPackageBytes,
  featureNoteIdWord,
  feeSponsorshipStorage,
  noteScript,
  NOTE_KINDS,
  ownOutputNotesRequest,
  poolInitSlots,
  wasmModule,
  wordFromWord4,
} from "../dist/index.js";

const client = await MidenClient.createMock();
const sender = (await client.accounts.create({ storage: "public" })).id();
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

const ZERO_WORD =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Contract packages deserialise into note scripts.
const roots = new Set(NOTE_KINDS.map((kind) => noteScript(kind).root().toHex()));
assert.equal(roots.size, NOTE_KINDS.length, "note roots must be distinct");
for (const kind of NOTE_KINDS) {
  assert.notEqual(noteScript(kind).root().toHex(), ZERO_WORD, `${kind} root`);
}

// Pool component builds from the pool package and the 11 slots.
const poolPkg = Package.deserialize(contractPackageBytes("pool"));
const { StorageSlotArray } = wasmModule();
const slotArray = new StorageSlotArray(
  poolInitSlots({
    token0Key: [1n, 2n, 3n, 4n],
    token1Key: [5n, 6n, 7n, 8n],
    admin: sender,
  }).map((def) =>
    def.value === null
      ? StorageSlot.emptyValue(def.name)
      : StorageSlot.fromValue(def.name, wordFromWord4(def.value)),
  ),
);
const poolComponent = AccountComponent.fromPackage(poolPkg, slotArray);
assert.ok(poolComponent.getProcedures().length > 0, "pool procedures");

// Mint note: 2 assets, network note, correct script root.
const mint = buildMintNote({
  sender,
  poolId: sender,
  recipient: sender,
  token0,
  token1,
  amount0: 1000n,
  amount1: 1000n,
  minLpOut: 0n,
  deadline: 1_000_000_000n,
});
assert.equal(mint.isNetworkNote(), true);
assert.equal(mint.script().root().toHex(), noteScript("mint").root().toHex());
assert.equal(mint.assets().fungibleAssets().length, 2);

// Swap note: 1 asset.
const swap = buildSwapNote({
  sender,
  poolId: sender,
  recipient: sender,
  tokenIn: token0,
  amountIn: 100n,
  minAmountOut: 0n,
  deadline: 1_000_000_000n,
});
assert.equal(swap.isNetworkNote(), true);
assert.equal(swap.script().root().toHex(), noteScript("swap").root().toHex());
assert.equal(swap.assets().fungibleAssets().length, 1);

// Burn note: LP asset issued by the pool id.
const burn = buildBurnNote({
  sender,
  poolId: sender,
  recipient: sender,
  amountLp: 10n,
  minAmount0: 0n,
  minAmount1: 0n,
  deadline: 1_000_000_000n,
});
assert.equal(burn.isNetworkNote(), true);
assert.equal(burn.assets().fungibleAssets().length, 1);
assert.equal(burn.assets().fungibleAssets()[0].faucetId().toString(), sender.toString());

// Collect note: no assets.
const collect = buildCollectNote({ sender, poolId: sender });
assert.equal(collect.isNetworkNote(), true);
assert.equal(collect.assets().fungibleAssets().length, 0);

// Admin note: 14-felt storage.
const admin = buildAdminNote({
  sender,
  poolId: sender,
  feeTo: sender,
  lpFeeBps: 30n,
  protocolFeeBps: 10n,
});
assert.equal(admin.isNetworkNote(), true);
const adminItems = admin.recipient().storage().items();
assert.equal(adminItems.length, 14);
assert.equal(adminItems[4].asInt(), 30n);
assert.equal(adminItems[5].asInt(), 10n);

// Fee sponsorship note: bound to the swap note id, one fee asset.
const sponsor = buildFeeSponsorshipNote({
  sender,
  target: sender,
  featureNote: swap,
  feeFaucetId: feeFaucet,
  feeAmount: 5n,
});
assert.equal(sponsor.script().root().toHex(), NoteScript.feeSponsorship().root().toHex());
assert.equal(sponsor.assets().fungibleAssets().length, 1);
assert.equal(sponsor.assets().fungibleAssets()[0].faucetId().toString(), feeFaucet.toString());
assert.equal(sponsor.assets().fungibleAssets()[0].amount(), 5n);
const sponsorItems = sponsor.recipient().storage().items().map((f) => f.asInt());
const expectedSponsor = feeSponsorshipStorage({
  featureNoteId: featureNoteIdWord(swap),
  reclaimer: sender,
  reclaimHeight: 0n,
});
assert.deepEqual(sponsorItems, expectedSponsor);

// Two-note own-output request assembles.
const request = ownOutputNotesRequest([swap, sponsor]);
assert.ok(request);

console.log("wasm-smoke: ok");
