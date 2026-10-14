/**
 * Reads of the on-chain pool registry account.
 *
 * The registry stores three storage maps. Keys and values are four-felt words:
 * a pool id key is `[prefix, suffix, 0, 0]`; an ordered asset pair key is
 * `[lo.prefix, lo.suffix, hi.prefix, hi.suffix]`; a code commitment is the
 * pool account's code commitment.
 *
 * The node returns at most 1000 entries per map in one `getAccountDetails`
 * response. Above that, the registry map must be paged with
 * `SyncAccountStorageMaps`; the SDK reports the truncation rather than
 * returning a partial list.
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
import { randomSeed, type Word4 } from "../math/encoding.js";
import { MAX_TX_FEE, REGISTRY_SLOTS } from "../constants.js";
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
 * The registry's fee policy: who receives protocol fees, at what rate, and
 * which LP fee tiers a pool may charge.
 *
 * A pool's own fee configuration is frozen at creation and validated against
 * this by `register`, so a creator must build the pool with these values. They
 * are read rather than configured, because the registry is what enforces them.
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
  /** 32-byte account seed; defaults to a fresh random seed. */
  seed?: Uint8Array;
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
  ]);

  const registryPackage = Package.deserialize(contractPackageBytes("registry"));
  const registryComponent = AccountComponent.fromPackage(
    registryPackage,
    slots,
  );

  // Every admitted script root must carry a fee: a root that the fee policy does
  // not price aborts fee estimation for that note, so the registry could never
  // consume it. Both are priced at the protocol maximum, so the prepaid
  // sponsorship always covers the actual transaction fee; the registry keeps the
  // difference and a later collect sweeps it.
  const registerFee =
    params.registerFee > MAX_TX_FEE ? params.registerFee : MAX_TX_FEE;
  const feeEntries = [
    new NoteScriptFee(noteScript("register").root(), registerFee),
    new NoteScriptFee(noteScript("registry-collect").root(), MAX_TX_FEE),
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
