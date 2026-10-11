/**
 * `XykClient` and `Pool` facade.
 *
 * The facade binds a web-sdk `MidenClient` to a `PoolConfig` and fetches pool
 * state internally, so the application calls one method per action and never
 * touches the note layouts, quotes, or fee sponsorship notes directly.
 */
import type { Account, AccountId, MidenClient } from "@miden-sdk/miden-sdk";
import type { Word4 } from "./math/encoding.js";
import {
  addLiquidity,
  collectFees,
  registerPool,
  removeLiquidity,
  swap,
  type BurnOutput,
  type BurnParams,
  type CollectParams,
  type MintOutput,
  type MintParams,
  type OperationOutput,
  type RegisterPoolOutput,
  type RegisterPoolParams,
  type RegistryConfig,
  type SubmitOptions,
  type SwapOutput,
  type SwapParams,
} from "./ops/operations.js";
import { fetchPoolState, type PoolState } from "./pool/reads.js";
import {
  createFeeFaucet,
  createPoolAccount,
  deployPoolAccount,
  type CreatePoolAccountParams,
  type DeployOptions,
  type FeeFaucetParams,
} from "./pool/create.js";
import type { PoolConfig } from "./pool/config.js";
import {
  createRegistryAccount,
  deployRegistryAccount,
  readRegistryAcceptedCodeCommitments,
  readRegistryPoolForAssets,
  readRegistryPools,
  type CreateRegistryAccountParams,
  type RegistryPoolEntry,
} from "./pool/registry.js";

export class XykClient {
  constructor(readonly client: MidenClient) {}

  static from(client: MidenClient): XykClient {
    return new XykClient(client);
  }

  /** Returns a handle bound to one pool's configuration. */
  pool(config: PoolConfig): Pool {
    return new Pool(this.client, config);
  }

  createPoolAccount(params: CreatePoolAccountParams): Promise<Account> {
    return createPoolAccount(this.client, params);
  }

  deployPoolAccount(
    poolId: AccountId,
    fundingNoteId: string,
    options?: DeployOptions,
  ): ReturnType<typeof deployPoolAccount> {
    return deployPoolAccount(this.client, poolId, fundingNoteId, options);
  }

  createFeeFaucet(params: FeeFaucetParams): Promise<Account> {
    return createFeeFaucet(this.client, params);
  }

  createRegistryAccount(params: CreateRegistryAccountParams): Promise<Account> {
    return createRegistryAccount(this.client, params);
  }

  deployRegistryAccount(
    registryId: AccountId,
    fundingNoteId: string,
    options?: DeployOptions,
  ): Promise<import("@miden-sdk/miden-sdk").TransactionSubmitResult> {
    return deployRegistryAccount(
      this.client,
      registryId,
      fundingNoteId,
      options,
    );
  }

  /** Returns every pool id recorded in the registry and its code commitment. */
  listRegistryPools(registryId: AccountId): Promise<RegistryPoolEntry[]> {
    return readRegistryPools((id) => this.client.accounts.get(id), registryId);
  }

  /** Returns every accepted pool code commitment in the registry. */
  listRegistryAccepted(registryId: AccountId): Promise<Word4[]> {
    return readRegistryAcceptedCodeCommitments(
      (id) => this.client.accounts.get(id),
      registryId,
    );
  }

  /** Returns the registered pool for an asset pair, or null. */
  poolForAssets(
    registryId: AccountId,
    asset0: AccountId,
    asset1: AccountId,
  ): Promise<AccountId | null> {
    return readRegistryPoolForAssets(
      (id) => this.client.accounts.get(id),
      registryId,
      asset0,
      asset1,
    );
  }

  /** Emits the register note and its sponsorship note for a pool. */
  registerPool(
    config: RegistryConfig,
    params: RegisterPoolParams,
    options?: SubmitOptions,
  ): Promise<RegisterPoolOutput> {
    return registerPool(this.client, config, params, options);
  }
}

export class Pool {
  constructor(
    private readonly client: MidenClient,
    private readonly config: PoolConfig,
  ) {}

  get id(): AccountId {
    return this.config.poolId;
  }

  /** Fetches and decodes the pool's on-chain state. */
  async state(): Promise<PoolState> {
    return fetchPoolState(
      (id) => this.client.accounts.get(id),
      this.config.poolId,
    );
  }

  swap(params: SwapParams, options?: SubmitOptions): Promise<SwapOutput> {
    return (async () => swap(this.client, this.config, await this.state(), params, options))();
  }

  addLiquidity(
    params: MintParams,
    options?: SubmitOptions,
  ): Promise<MintOutput> {
    return (async () =>
      addLiquidity(this.client, this.config, await this.state(), params, options))();
  }

  removeLiquidity(
    params: BurnParams,
    options?: SubmitOptions,
  ): Promise<BurnOutput> {
    return (async () =>
      removeLiquidity(this.client, this.config, await this.state(), params, options))();
  }

  collectFees(
    params: CollectParams,
    options?: SubmitOptions,
  ): Promise<OperationOutput> {
    return (async () =>
      collectFees(this.client, this.config, await this.state(), params, options))();
  }

}
