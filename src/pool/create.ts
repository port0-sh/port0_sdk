/**
 * Pool account creation and deployment.
 *
 * An XYK pool is a public network account: it carries the miden-xyk account
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
  TransactionRequestBuilder,
  type MidenClient,
  type TransactionSubmitResult,
} from "@miden-sdk/miden-sdk";
import { contractPackageBytes } from "../artifacts.js";
import type { Word4 } from "../math/encoding.js";
import { randomSeed } from "../math/encoding.js";
import { wasmModule } from "../wasm.js";
import { NOTE_KINDS, noteScript, type NoteKind } from "../notes/scripts.js";
import { wordFromWord4 } from "../notes/word.js";
import { poolInitSlots } from "./slots.js";

/** Note consumption fees, denominated in the fee faucet asset. */
export type PoolNoteFees = Partial<Record<NoteKind, bigint>>;

export interface CreatePoolAccountParams {
  /** token0 asset key word. */
  token0Key: Word4;
  /** token1 asset key word. */
  token1Key: Word4;
  /** Admin account allowed to call `configure`. */
  admin: AccountId;
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
  const seed = params.seed ?? randomSeed();

  const { StorageSlotArray } = wasmModule();
  const slotArray = new StorageSlotArray(
    poolInitSlots({
      token0Key: params.token0Key,
      token1Key: params.token1Key,
      admin: params.admin,
    }).map((def) =>
      def.value === null
        ? StorageSlot.emptyValue(def.name)
        : StorageSlot.fromValue(def.name, wordFromWord4(def.value)),
    ),
  );

  const poolPackage = Package.deserialize(contractPackageBytes("pool"));
  const poolComponent = AccountComponent.fromPackage(poolPackage, slotArray);

  const feeEntries = NOTE_KINDS.map(
    (kind) =>
      new NoteScriptFee(noteScript(kind).root(), params.noteFees?.[kind] ?? 0n),
  );
  const authComponents = AccountComponent.createNetworkAuthComponents(
    feeEntries,
    params.feeFaucetId,
  );

  let builder = new AccountBuilder(seed)
    .storageMode(AccountStorageMode.public())
    .withComponent(poolComponent);
  for (const component of authComponents) {
    builder = builder.withComponent(component);
  }
  const built = builder.build();

  await client.accounts.insert({ account: built.account });
  return built.account;
}

export interface DeployOptions {
  /** Poll `transactions.waitFor` until the deploy transaction is confirmed. */
  waitForConfirmation?: boolean;
}

/**
 * Deploys a network-account pool with a scriptless (empty) transaction. The
 * network auth forbids tx scripts and bumps the nonce itself, so an empty
 * request is sufficient to commit the account on-chain.
 */
export async function deployPoolAccount(
  client: MidenClient,
  poolId: AccountId,
  options?: DeployOptions,
): Promise<TransactionSubmitResult> {
  const request = new TransactionRequestBuilder().build();
  const result = await client.transactions.submit(poolId, request);
  if (options?.waitForConfirmation) {
    await client.transactions.waitFor(result.txId);
  }
  return result;
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
