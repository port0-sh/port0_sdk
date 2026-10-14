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
  buildRegistryCollectNote,
  buildBurnNote,
  buildCollectNote,
  buildFeeSponsorshipNote,
  buildMintNote,
  buildPoolAccount,
  buildRegisterNote,
  buildSwapNote,
  contractPackageBytes,
  createRegistryAccount,
  featureNoteIdWord,
  feeSponsorshipStorage,
  fungibleAssetIdWord,
  noteScript,
  NOTE_KINDS,
  ownOutputNotesRequest,
  poolCodeCommitment,
  poolInitSlots,
  readRegistryAcceptedCodeCommitments,
  registerNoteStorage,
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

// Pool component builds from the pool package and the 10 slots.
const poolPkg = Package.deserialize(contractPackageBytes("pool"));
const { StorageSlotArray } = wasmModule();
const slotArray = new StorageSlotArray(
  poolInitSlots({
    token0Key: [1n, 2n, 3n, 4n],
    token1Key: [5n, 6n, 7n, 8n],
    registryId: sender,
    lpFeeBps: 30n,
    protocolFeeShareBps: 10n,
    p2idRoot: [9n, 10n, 11n, 12n],
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

// Collect note: no assets, one asset key in storage.
const collect = buildCollectNote({
  sender,
  poolId: sender,
  assetKeys: [[1n, 2n, 3n, 4n]],
});
assert.equal(collect.isNetworkNote(), true);
assert.equal(collect.assets().fungibleAssets().length, 0);

// Registry collect note: 10-felt storage, no assets, permissionless.
const registryCollect = buildRegistryCollectNote({
  sender,
  registryId: sender,
  assetKeys: [[1n, 2n, 3n, 4n]],
});
assert.equal(registryCollect.isNetworkNote(), true);
const collectItems = registryCollect.recipient().storage().items();
assert.equal(collectItems.length, 10);
// Layout: registry id (2), serial (4), then the asset key (4).
assert.equal(collectItems[6].asInt(), 1n);

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
const request = await ownOutputNotesRequest(client, [swap, sponsor], sender);
assert.ok(request);

// Register note: 8-felt storage, no assets, network note.
const register = buildRegisterNote({
  sender,
  registryId: sender,
  poolId: sender,
  asset0: token0,
  asset1: token1,
});
assert.equal(register.isNetworkNote(), true);
assert.equal(register.script().root().toHex(), noteScript("register").root().toHex());
assert.equal(register.assets().fungibleAssets().length, 0);
assert.deepEqual(
  register.recipient().storage().items().map((f) => f.asInt()),
  registerNoteStorage({
    registryId: sender,
    poolId: sender,
    asset0: token0,
    asset1: token1,
  }),
);

// Pool account builds with CodeInspection installed and exposes a code
// commitment. The commitment is over the code only, so it does not depend on
// the seed or the storage values.
const poolParams = {
  token0Key: fungibleAssetIdWord(token0),
  token1Key: fungibleAssetIdWord(token1),
  registryId: sender,
  lpFeeBps: 30n,
  protocolFeeShareBps: 10n,
  feeFaucetId: feeFaucet,
};
const poolAccount = await buildPoolAccount(client, poolParams);
const commitment = poolAccount.code().commitment().toHex();
assert.match(commitment, /^0x[0-9a-f]{64}$/);
const stableCommitment = await poolCodeCommitment(client, poolParams);
assert.equal(
  stableCommitment,
  commitment,
  "code commitment must not depend on the account seed",
);
console.log("pool code commitment:", commitment);

// Registry account builds as a network account with the accepted pool code
// commitment seeded and the register note allowlisted.
const registryAccount = await createRegistryAccount(client, {
  acceptedPoolCodeCommitment: commitment,
  feeFaucetId: feeFaucet,
  registerFee: 133n,
  protocolFeeTo: sender,
  protocolFeeShareBps: 10n,
  allowedLpFeeBps: [5n, 30n, 100n],
  p2idRoot: [9n, 10n, 11n, 12n],
});
assert.equal(registryAccount.isNetworkAccount(), true);

// The registry admits both of its note kinds, and none of the pool's. A root the
// fee policy does not price aborts fee estimation, so a missing entry here is a
// note the registry can never consume, however permissionless it is meant to be.
// The standard config and fee-sponsorship scripts are allowlisted on top of the
// caller's roots, so the allowlist is longer than the two below.
const registryAllowlist = new Set(
  (registryAccount.networkNoteAllowlist() ?? []).map((root) => root.toHex()),
);
console.log(`registry allowlist: ${registryAllowlist.size} roots`);
for (const kind of ["register", "registry-collect"]) {
  assert.ok(
    registryAllowlist.has(noteScript(kind).root().toHex()),
    `registry admits the ${kind} note`,
  );
}
for (const kind of ["mint", "burn", "swap", "collect"]) {
  assert.ok(
    !registryAllowlist.has(noteScript(kind).root().toHex()),
    `registry does not admit the ${kind} note`,
  );
}
const accepted = await readRegistryAcceptedCodeCommitments(
  (id) => client.accounts.get(id),
  registryAccount.id(),
);
assert.equal(accepted.length, 1);
const expectedLimbs = Array.from(
  wasmModule().Word.fromHex(commitment).toU64s(),
);
assert.deepEqual([...accepted[0]], expectedLimbs);

console.log("wasm-smoke: ok");
