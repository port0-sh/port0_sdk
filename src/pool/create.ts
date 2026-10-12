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
  AccountComponent,
  AccountId,
  AccountStorageMode,
  FaucetType,
  NoteScriptFee,
  Package,
  StorageSlot,
  type MidenClient,
  type TransactionSubmitResult,
} from "@miden-sdk/miden-sdk";
import { contractPackageBytes } from "../artifacts.js";
import { p2idRoot } from "../notes/build.js";
import type { Word4 } from "../math/encoding.js";
import { randomSeed } from "../math/encoding.js";
import { wasmModule } from "../wasm.js";
import { POOL_NOTE_KINDS, noteScript, type PoolNoteKind } from "../notes/scripts.js";
import { wordFromWord4 } from "../notes/word.js";
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

  const codeInspection = await codeInspectionComponent(client);

  const feeEntries = POOL_NOTE_KINDS.map(
    (kind) =>
      new NoteScriptFee(noteScript(kind).root(), params.noteFees?.[kind] ?? 0n),
  );
  const authComponents = AccountComponent.createNetworkAuthComponents(
    feeEntries,
    params.feeFaucetId,
  );

  let builder = new AccountBuilder(seed)
    .storageMode(AccountStorageMode.public())
    .withComponent(poolComponent)
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
