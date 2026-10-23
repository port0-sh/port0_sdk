/**
 * Reads of the on-chain pool registry.
 *
 * Three storage maps, keyed and valued by four-felt words: a pool id key is
 * `[prefix, suffix, 0, 0]`, an ordered asset pair key is
 * `[lo.prefix, lo.suffix, hi.prefix, hi.suffix]`, and a commitment is the pool
 * account's code commitment.
 *
 * One account read returns at most 1000 map entries. Above that the map must be
 * paged with `SyncAccountStorageMaps`; these readers report the truncation rather
 * than return a partial list.
 */
import {
  Account,
  AccountBuilder,
  AccountComponent,
  AccountId,
  AccountStorageMode,
  Felt,
  NoteScriptFee,
  Package,
  StorageSlot,
  StorageView,
  Word,
  type MidenClient,
  type TransactionSubmitResult,
} from "@miden-sdk/miden-sdk";
import { contractPackageBytes } from "../artifacts.js";
import { XykError } from "../errors.js";
import type { PoolAuthRoots } from "./create.js";
import { randomSeed, type Word4 } from "../math/encoding.js";
import { REGISTRY_SLOTS, NOTE_FEES } from "../constants.js";
import { noteScript } from "../notes/scripts.js";
import { word4FromWord, wordFromWord4 } from "../notes/word.js";
import { wasmModule } from "../wasm.js";
import type { DeployOptions } from "./create.js";

/** Registry storage slot names, derived from the component metadata. */
/** One registered pool and the code commitment recorded for it. */
export interface RegistryPoolEntry {
  poolId: AccountId;
  codeCommitment: Word4;
}

function registryStorage(account: Account): StorageView {
  // 0.17: Account.storage() is patched to return StorageView at runtime.
  return account.storage() as unknown as StorageView;
}

function poolIdFromKey(key: Word): AccountId {
  const limbs = key.toU64s();
  return AccountId.fromPrefixSuffix(
    new Felt(limbs[0] ?? 0n),
    new Felt(limbs[1] ?? 0n),
  );
}

async function fetchRegistry(
  getAccount: (id: AccountId) => Promise<Account | null>,
  registryId: AccountId,
): Promise<Account> {
  const account = await getAccount(registryId);
  if (!account) {
    throw new XykError(
      "POOL_NOT_FOUND",
      `registry account ${registryId.toString()} not found`,
    );
  }
  return account;
}

/**
 * Returns every registered pool id and its recorded code commitment.
 *
 * Throws `INVARIANT` when the registry's `pools` map holds more entries than
 * one account read returns, so a caller never mistakes a truncated list for the
 * full set.
 */
export async function readRegistryPools(
  getAccount: (id: AccountId) => Promise<Account | null>,
  registryId: AccountId,
): Promise<RegistryPoolEntry[]> {
  const account = await fetchRegistry(getAccount, registryId);
  const storage = registryStorage(account);
  const entries = storage.getMapEntries(REGISTRY_SLOTS.pools);
  if (!entries) {
    return [];
  }

  return entries.map((entry) => ({
    poolId: poolIdFromKey(Word.fromHex(entry.key)),
    codeCommitment: word4FromWord(Word.fromHex(entry.value)),
  }));
}

/**
 * The registry's fee policy: protocol fee recipient, share, and the LP tiers a
 * pool may charge. A pool is built with these values and `register` rejects any
 * other, so they are read rather than configured.
 */
export interface RegistryFeePolicy {
  protocolFeeTo: AccountId;
  protocolFeeShareBps: bigint;
  allowedLpFeeBps: bigint[];
}

export async function readRegistryFeePolicy(
  getAccount: (id: AccountId) => Promise<Account | null>,
  registryId: AccountId,
): Promise<RegistryFeePolicy> {
  const account = await fetchRegistry(getAccount, registryId);
  const storage = registryStorage(account);

  // Value slots hold one word. An account id is stored `[0, 0, suffix, prefix]`;
  // a scalar is stored `[value, 0, 0, 0]`.
  const feeTo = storage.getItem(REGISTRY_SLOTS.protocolFeeTo)?.word?.toU64s() ?? [];
  const rate = storage.getItem(REGISTRY_SLOTS.protocolFeeShareBps)?.word?.toU64s() ?? [];
  const tiers = (storage.getMapEntries(REGISTRY_SLOTS.allowedLpFeeBps) ?? []).map((entry) =>
    BigInt(Word.fromHex(entry.key).toU64s()[0] ?? 0n),
  );

  return {
    protocolFeeTo: AccountId.fromPrefixSuffix(
      new Felt(feeTo[3] ?? 0n),
      new Felt(feeTo[2] ?? 0n),
    ),
    protocolFeeShareBps: BigInt(rate[0] ?? 0n),
    allowedLpFeeBps: tiers.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}

/** Returns the registered pool for an asset pair, or null. */
export async function readRegistryPoolForAssets(
  getAccount: (id: AccountId) => Promise<Account | null>,
  registryId: AccountId,
  asset0: AccountId,
  asset1: AccountId,
): Promise<AccountId | null> {
  const account = await fetchRegistry(getAccount, registryId);
  const storage = registryStorage(account);
  const entries = storage.getMapEntries(REGISTRY_SLOTS.assetsToPool);
  if (!entries) {
    return null;
  }

  const [lo, hi] = orderAssets(asset0, asset1);
  const wanted = pairKey(lo, hi).toHex().toLowerCase();
  for (const entry of entries) {
    if (entry.key.toLowerCase() === wanted) {
      return poolIdFromKey(Word.fromHex(entry.value));
    }
  }
  return null;
}

/** Returns every accepted pool code commitment in the registry. */
export async function readRegistryAcceptedCodeCommitments(
  getAccount: (id: AccountId) => Promise<Account | null>,
  registryId: AccountId,
): Promise<Word4[]> {
  const account = await fetchRegistry(getAccount, registryId);
  const storage = registryStorage(account);
  const entries = storage.getMapEntries(REGISTRY_SLOTS.acceptedCodeCommitments);
  if (!entries) {
    return [];
  }
  return entries.map((entry) => word4FromWord(Word.fromHex(entry.key)));
}

function orderAssets(a: AccountId, b: AccountId): [AccountId, AccountId] {
  const keyA = [a.prefix().asInt(), a.suffix().asInt()] as const;
  const keyB = [b.prefix().asInt(), b.suffix().asInt()] as const;
  const aFirst =
    keyA[0] < keyB[0] || (keyA[0] === keyB[0] && keyA[1] <= keyB[1]);
  return aFirst ? [a, b] : [b, a];
}

function pairKey(lo: AccountId, hi: AccountId): Word {
  return new Word(
    new BigUint64Array([
      lo.prefix().asInt(),
      lo.suffix().asInt(),
      hi.prefix().asInt(),
      hi.suffix().asInt(),
    ]),
  );
}

/** Parameters for creating the registry account. */
/**
 * Parses an account reference: hex with the 0x prefix, or bech32.
 *
 * `AccountId.fromHex` accepts only hex, and callers reasonably hold a bech32
 * address (`mtst1...`), so both forms are accepted wherever this SDK takes an
 * account from configuration.
 */
export function parseAccountId(value: AccountId | string): AccountId {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? AccountId.fromHex(trimmed)
    : AccountId.fromBech32(trimmed);
}

export interface CreateRegistryAccountParams {
  /** Accepted pool code commitment, lowercase hex (`poolCodeCommitment`). */
  acceptedPoolCodeCommitment: string;
  /** Faucet whose asset denominates the register note fee; hex or bech32. */
  feeFaucetId: AccountId | string;
  /** Register note consumption fee, fixed at creation. */
  registerFee: bigint;
  /** Account that receives every pool's protocol fees; hex or bech32. */
  protocolFeeTo: AccountId | string;
  /** Protocol fee rate, in basis points, that a pool must be created with. */
  protocolFeeShareBps: bigint;
  /** LP fee tiers, in basis points, that a pool may charge. */
  allowedLpFeeBps: readonly bigint[];
  /** Script root of the note that pays register fees out. */
  p2idRoot: Word4;
  /**
   * Account allowed to change the register fee. The registry compares it
   * against the sender of a registry-config note.
   */
  admin: AccountId | string;
  /**
   * Auth roots every pool must carry, from `poolAuthRoots`. Registration
   * compares the pool's own roots against these, so a pool with an allowlist of
   * its own cannot be listed.
   */
  authRoots: PoolAuthRoots;
  /** 32-byte account seed; defaults to a fresh random seed. */
  seed?: Uint8Array;
}

/** The auth component's constant-fee schedule slot. */
const FEE_SCHEDULE_SLOT =
  "miden::standards::fees::policies::basic_constant_fee::fee_schedule";

/**
 * Reads the registry's admin: the account whose registry-config notes may change
 * the register fee. A wallet that is not this account cannot change it.
 */
export async function readRegistryAdmin(
  getAccount: (id: AccountId) => Promise<Account | null>,
  registryId: AccountId,
): Promise<AccountId> {
  const account = await getAccount(registryId);
  if (!account) {
    throw new XykError(
      "POOL_NOT_FOUND",
      `registry account ${registryId.toString()} not found`,
    );
  }
  const word = registryStorage(account).getItem(REGISTRY_SLOTS.admin)?.word;
  if (!word) {
    throw new XykError("MISSING_SLOT", "the registry has no admin slot");
  }
  // The admin word is `[0, 0, suffix, prefix]`, each half a felt holding a u64.
  // Rebuild the id from those halves: an account id's hex form is the
  // concatenation of two unpadded u64s, so padding each half and joining them
  // produces a different id.
  const { Felt } = wasmModule();
  const limbs = word.toU64s();
  return AccountId.fromPrefixSuffix(
    new Felt(BigInt(limbs[3] ?? 0n)),
    new Felt(BigInt(limbs[2] ?? 0n)),
  );
}

/**
 * Reads the registry's live register fee, in the fee asset's base units.
 *
 * The fee is an entry in the registry's own fee schedule, so after the admin
 * changes it this is the authoritative price; the SDK's `NOTE_FEES.register` is
 * only the value a fresh registry starts with.
 */
export async function readRegistryRegisterFee(
  getAccount: (id: AccountId) => Promise<Account | null>,
  registryId: AccountId,
): Promise<bigint> {
  const { Word } = wasmModule();
  const account = await getAccount(registryId);
  if (!account) {
    throw new XykError(
      "POOL_NOT_FOUND",
      `registry account ${registryId.toString()} not found`,
    );
  }
  const storage = registryStorage(account);
  const entries = storage.getMapEntries(FEE_SCHEDULE_SLOT);
  const root = noteScript("register").root().toHex().replace(/^0x/, "").toLowerCase();
  const entry = entries?.find(
    (item) => String(item.key).replace(/^0x/, "").toLowerCase() === root,
  );
  if (!entry) {
    throw new XykError(
      "MISSING_SLOT",
      `the registry prices no register note; nothing can be registered`,
    );
  }
  return BigInt(Word.fromHex(entry.value).toU64s()[0] ?? 0n);
}

/**
 * Builds the registry network account, seeds `accepted_code_commitments` with
 * the accepted pool code commitment, installs the network auth admitting the
 * registry's two note kinds, and inserts the account into the client's local
 * store. Does not deploy it; call `deployRegistryAccount` for that.
 */
export async function createRegistryAccount(
  client: MidenClient,
  params: CreateRegistryAccountParams,
): Promise<Account> {
  const { StorageMap, StorageSlotArray, Word } = wasmModule();

  const accepted = new StorageMap();
  accepted.insert(
    Word.fromHex(params.acceptedPoolCodeCommitment),
    wordFromWord4([1n, 0n, 0n, 0n]),
  );

  // The tiers a pool may charge. Registration rejects anything else, so this
  // map is what makes the listing's fee set a property of the registry rather
  // than of whoever deployed the pool.
  const tiers = new StorageMap();
  for (const bps of params.allowedLpFeeBps) {
    tiers.insert(wordFromWord4([bps, 0n, 0n, 0n]), wordFromWord4([1n, 0n, 0n, 0n]));
  }

  const protocolFeeTo = parseAccountId(params.protocolFeeTo);
  const admin = parseAccountId(params.admin);
  const slots = new StorageSlotArray([
    StorageSlot.map(REGISTRY_SLOTS.acceptedCodeCommitments, accepted),
    StorageSlot.map(REGISTRY_SLOTS.pools, new StorageMap()),
    StorageSlot.map(REGISTRY_SLOTS.assetsToPool, new StorageMap()),
    StorageSlot.map(REGISTRY_SLOTS.allowedLpFeeBps, tiers),
    // protocol_fee_to word: [0, 0, suffix, prefix]
    StorageSlot.fromValue(
      REGISTRY_SLOTS.protocolFeeTo,
      wordFromWord4([0n, 0n, protocolFeeTo.suffix().asInt(), protocolFeeTo.prefix().asInt()]),
    ),
    StorageSlot.fromValue(
      REGISTRY_SLOTS.protocolFeeShareBps,
      wordFromWord4([params.protocolFeeShareBps, 0n, 0n, 0n]),
    ),
    StorageSlot.fromValue(REGISTRY_SLOTS.p2idRoot, wordFromWord4(params.p2idRoot)),
    StorageSlot.fromValue(
      REGISTRY_SLOTS.expectedNoteAllowlistRoot,
      wordFromWord4(params.authRoots.noteAllowlistRoot),
    ),
    StorageSlot.fromValue(
      REGISTRY_SLOTS.expectedTxScriptAllowlistRoot,
      wordFromWord4(params.authRoots.txScriptAllowlistRoot),
    ),
    StorageSlot.fromValue(
      REGISTRY_SLOTS.expectedFeeScheduleRoot,
      wordFromWord4(params.authRoots.feeScheduleRoot),
    ),
    StorageSlot.fromValue(
      REGISTRY_SLOTS.expectedFeeAssetId,
      wordFromWord4(params.authRoots.feeAssetId),
    ),
    StorageSlot.fromValue(
      REGISTRY_SLOTS.expectedActiveFeePolicyRoot,
      wordFromWord4(params.authRoots.activeFeePolicyRoot),
    ),
    StorageSlot.fromValue(
      REGISTRY_SLOTS.expectedAllowedFeePolicyRoots,
      wordFromWord4(params.authRoots.allowedFeePolicyRoots),
    ),
    // The only script root whose fee the admin's setter may change.
    StorageSlot.fromValue(
      REGISTRY_SLOTS.registerNoteRoot,
      wordFromWord4(Array.from(noteScript("register").root().toU64s()).map((limb) => BigInt(limb)) as unknown as Word4),
    ),
    // admin word: [0, 0, suffix, prefix]
    StorageSlot.fromValue(
      REGISTRY_SLOTS.admin,
      wordFromWord4([0n, 0n, admin.suffix().asInt(), admin.prefix().asInt()]),
    ),
  ]);

  const registryPackage = Package.deserialize(contractPackageBytes("registry"));
  const registryComponent = AccountComponent.fromPackage(
    registryPackage,
    slots,
  );

  // Every admitted script root must carry a fee: a root that the fee policy does
  // not price aborts fee estimation for that note, so the registry could never
  // consume it. The prices are the measured schedule, so the prepaid sponsorship
  // covers the actual transaction fee with the pricer's one-cycle margin.
  const registerFee = params.registerFee > 0n ? params.registerFee : NOTE_FEES.register;
  // The config note is priced at zero: the registry pays its own fee from the
  // balance it has accumulated, and the admin pays nothing to change the price.
  const feeEntries = [
    new NoteScriptFee(noteScript("register").root(), registerFee),
    new NoteScriptFee(noteScript("registry-collect").root(), NOTE_FEES["registry-collect"]),
    new NoteScriptFee(noteScript("registry-config").root(), 0n),
  ];
  const authComponents = AccountComponent.createNetworkAuthComponents(
    feeEntries,
    parseAccountId(params.feeFaucetId),
  );

  let builder = new AccountBuilder(params.seed ?? randomSeed())
    .storageMode(AccountStorageMode.public())
    .withComponent(registryComponent);
  for (const component of authComponents) {
    builder = builder.withComponent(component);
  }

  const account = builder.build().account;
  await client.accounts.insert({ account });
  return account;
}

/**
 * Deploys the registry network account by consuming a funding note as its
 * first transaction. The 0.17 network auth rejects a transaction with no
 * effect, so the funding note both commits the account and pays its first fee.
 */
export async function deployRegistryAccount(
  client: MidenClient,
  registryId: AccountId,
  fundingNoteId: string,
  options?: DeployOptions,
): Promise<TransactionSubmitResult> {
  return client.transactions.consume({
    account: registryId.toString(),
    notes: [fundingNoteId],
    waitForConfirmation: options?.waitForConfirmation ?? false,
  });
}
