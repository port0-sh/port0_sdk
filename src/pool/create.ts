/**
 * Pool account creation and deployment.
 *
 * An XYK pool is a public network account: it carries the port0 account
 * component plus the standard network-account auth component, whose
 * note-script allowlist is what the node's network transaction builder reads
 * to auto-consume the pool's notes. There is no signature key.
 */
import {
  Account,
  AccountBuilder,
  AccountId,
  AccountComponent,
  AccountStorageMode,
  FaucetType,
  NoteScriptFee,
  Package,
  StorageSlot,
  type MidenClient,
  type TransactionSubmitResult,
} from "@miden-sdk/miden-sdk";
import { contractPackageBytes } from "../artifacts.js";
import { NOTE_FEES, POOL_AUTH_SLOTS } from "../constants.js";
import { asAccountId } from "../utils/accountId.js";
import { XykError } from "../errors.js";
import { p2idRoot } from "../notes/build.js";
import type { Word4 } from "../math/encoding.js";
import { randomSeed } from "../math/encoding.js";
import { wasmModule } from "../wasm.js";
import { POOL_NOTE_KINDS, noteScript, type PoolNoteKind } from "../notes/scripts.js";
import { wordFromWord4 } from "../notes/word.js";
import { lpFaucetComponent } from "./lpFaucet.js";
import { poolInitSlots } from "./slots.js";

/** Note consumption fees, denominated in the fee faucet asset. */
export type PoolNoteFees = Partial<Record<PoolNoteKind, bigint>>;

/**
 * MASM for the standard `CodeInspection` component, re-exported from
 * `miden-standards` 0.17.1. Installing it on the pool exposes
 * `get_code_commitment`, which the registry calls over FPI to verify the pool
 * code at registration. The assembly links the client's standards library.
 */
const CODE_INSPECTION_MASM =
  "pub use { get_code_commitment, get_num_procedures, get_procedure_root, has_procedure } from miden::standards::inspection::code_inspection";

const codeInspectionCache = new WeakMap<
  MidenClient,
  Promise<AccountComponent>
>();

/** Compiles the standard `CodeInspection` component once per client. */
function codeInspectionComponent(
  client: MidenClient,
): Promise<AccountComponent> {
  let cached = codeInspectionCache.get(client);
  if (!cached) {
    cached = client.compile.component({ code: CODE_INSPECTION_MASM, slots: [] });
    codeInspectionCache.set(client, cached);
  }
  return cached;
}

export interface CreatePoolAccountParams {
  /** token0 asset key word. */
  token0Key: Word4;
  /** token1 asset key word. */
  token1Key: Word4;
  /** Registry the pool reads its protocol fee destination from. */
  registryId: AccountId;
  /** Symbol of token0, for the LP token's metadata. */
  token0Symbol: string;
  /** Symbol of token1, for the LP token's metadata. */
  token1Symbol: string;
  /** LP fee in basis points; the registry lists a fixed set of tiers. */
  lpFeeBps: bigint;
  /** Protocol fee in basis points; must equal the registry's rate. */
  protocolFeeShareBps: bigint;
  /** Optional P2ID script root; defaults to the standard P2ID root. */
  p2idRoot?: Word4;
  /** Faucet whose asset denominates network note consumption fees. */
  feeFaucetId: AccountId;
  /** Per-note-kind consumption fees; unset kinds default to 0. */
  noteFees?: PoolNoteFees;
  /** 32-byte account seed; defaults to a fresh random seed. */
  seed?: Uint8Array;
}

/**
 * Builds the pool account, installs the network auth with the given fee
 * schedule, and inserts it into the client's local store. Does not deploy it
 * on-chain; call `deployPoolAccount` for that.
 */
export async function createPoolAccount(
  client: MidenClient,
  params: CreatePoolAccountParams,
): Promise<Account> {
  const account = await buildPoolAccount(client, params);
  await client.accounts.insert({ account });
  return account;
}

/**
 * Builds the pool account without inserting it into the client's store.
 *
 * The account's seed affects the account id, not the code, so the code
 * commitment is identical across seeds and across storage values.
 */
export async function buildPoolAccount(
  client: MidenClient,
  params: CreatePoolAccountParams,
): Promise<Account> {
  const seed = params.seed ?? randomSeed();

  const { StorageSlotArray } = wasmModule();
  const slotArray = new StorageSlotArray(
    poolInitSlots({
      token0Key: params.token0Key,
      token1Key: params.token1Key,
      registryId: params.registryId,
      lpFeeBps: params.lpFeeBps,
      protocolFeeShareBps: params.protocolFeeShareBps,
      p2idRoot: params.p2idRoot ?? p2idRoot(),
    }).map((def) =>
      def.value === null
        ? StorageSlot.emptyValue(def.name)
        : StorageSlot.fromValue(def.name, wordFromWord4(def.value)),
    ),
  );

  const poolPackage = Package.deserialize(contractPackageBytes("pool"));
  const poolComponent = AccountComponent.fromPackage(poolPackage, slotArray);

  // The pool is its own LP faucet. Carrying the standard faucet component gives
  // the LP asset the name, symbol, and decimals wallets read.
  const lpFaucet = await lpFaucetComponent(client, {
    token0Symbol: params.token0Symbol,
    token1Symbol: params.token1Symbol,
  });

  const codeInspection = await codeInspectionComponent(client);

  const feeEntries = POOL_NOTE_KINDS.map(
    (kind) =>
      new NoteScriptFee(noteScript(kind).root(), params.noteFees?.[kind] ?? NOTE_FEES[kind]),
  );
  // Callers pass either a parsed id or a hex/bech32 string; the native binding
  // needs the object.
  const authComponents = AccountComponent.createNetworkAuthComponents(
    feeEntries,
    asAccountId(params.feeFaucetId),
  );

  let builder = new AccountBuilder(seed)
    .storageMode(AccountStorageMode.public())
    .withComponent(poolComponent)
    .withComponent(lpFaucet)
    .withComponent(codeInspection);
  for (const component of authComponents) {
    builder = builder.withComponent(component);
  }
  return builder.build().account;
}

/** Seed used only to build a throwaway pool for commitment computation. */
const COMMITMENT_SEED = new Uint8Array(32);

/**
 * Returns the pool account code commitment as lowercase hex.
 *
 * This is the value the registry's `accepted_code_commitments` map must hold.
 * It is computed by building the pool through the same path as
 * `createPoolAccount`, so it cannot drift from the deployed account. Storage
 * values and the account seed do not affect it.
 */
export async function poolCodeCommitment(
  client: MidenClient,
  params: Omit<CreatePoolAccountParams, "seed">,
): Promise<string> {
  const account = await buildPoolAccount(client, {
    ...params,
    seed: COMMITMENT_SEED,
  });
  return account.code().commitment().toHex();
}

/**
 * The storage roots a registry must require of every pool: its two allowlist
 * maps, its fee schedule, and the fee manager's own three items. Read from a
 * reference pool build, so they cannot drift from what `buildPoolAccount`
 * installs. The pool's payout root is compared against the registry's P2ID root
 * instead, since both must be the standard P2ID script.
 *
 * A pool carries the accepted code but its own storage, and an allowlist of its
 * own would admit a note that drains the vault through the wallet's
 * `move_asset_to_note`. The registry stores these roots at creation and compares
 * them on every registration.
 */
export interface PoolAuthRoots {
  noteAllowlistRoot: Word4;
  txScriptAllowlistRoot: Word4;
  feeScheduleRoot: Word4;
  feeAssetId: Word4;
  activeFeePolicyRoot: Word4;
  allowedFeePolicyRoots: Word4;
}

/** Reads the pool's auth roots from a reference pool built through `buildPoolAccount`. */
export async function poolAuthRoots(
  client: MidenClient,
  params: Omit<CreatePoolAccountParams, "seed">,
): Promise<PoolAuthRoots> {
  const account = await buildPoolAccount(client, {
    ...params,
    seed: COMMITMENT_SEED,
  });
  // `storage().getCommitment(name)` is the map root for a map slot.
  const storage = account.storage() as unknown as {
    getCommitment: (name: string) => { toU64s: () => BigUint64Array };
  };
  const read = (name: string): Word4 => {
    const word = storage.getCommitment(name);
    if (!word) {
      throw new XykError(
        "AUTH_SLOT_MISSING",
        `the reference pool has no ${name} storage; the auth component changed`,
      );
    }
    return Array.from(word.toU64s()) as unknown as Word4;
  };
  return {
    noteAllowlistRoot: read(POOL_AUTH_SLOTS.noteAllowlistRoot),
    txScriptAllowlistRoot: read(POOL_AUTH_SLOTS.txScriptAllowlistRoot),
    feeScheduleRoot: read(POOL_AUTH_SLOTS.feeScheduleRoot),
    feeAssetId: read(POOL_AUTH_SLOTS.feeAssetId),
    activeFeePolicyRoot: read(POOL_AUTH_SLOTS.activeFeePolicyRoot),
    allowedFeePolicyRoots: read(POOL_AUTH_SLOTS.allowedFeePolicyRoots),
  };
}

export interface DeployOptions {
  /** Poll until the deploy transaction is confirmed. */
  waitForConfirmation?: boolean;
}

/**
 * Deploys a network-account pool by consuming a funding note as its first
 * transaction. The 0.17 network auth rejects transactions with no effect, so
 * an empty scriptless transaction no longer commits the account; consuming an
 * input note both commits the account and pays its first transaction fee from
 * the received funds.
 */
export async function deployPoolAccount(
  client: MidenClient,
  poolId: AccountId,
  fundingNoteId: string,
  options?: DeployOptions,
): Promise<TransactionSubmitResult> {
  return client.transactions.consume({
    account: poolId.toString(),
    notes: [fundingNoteId],
    waitForConfirmation: options?.waitForConfirmation ?? false,
  });
}

export interface FeeFaucetParams {
  symbol: string;
  name?: string;
  decimals: number;
  maxSupply: bigint;
}

/** Creates a public fungible faucet for network note consumption fees. */
export async function createFeeFaucet(
  client: MidenClient,
  params: FeeFaucetParams,
): Promise<Account> {
  return client.accounts.create({
    type: FaucetType.FungibleFaucet,
    symbol: params.symbol,
    name: params.name ?? params.symbol,
    decimals: params.decimals,
    maxSupply: params.maxSupply,
    storage: "public",
  });
}
