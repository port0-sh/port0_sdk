/**
 * `XykClient` and `Pool` facade.
 *
 * The facade binds a web-sdk `MidenClient` to a `PoolConfig` and fetches pool
 * state internally, so the application calls one method per action and never
 * touches the note layouts, quotes, or fee sponsorship notes directly.
 */
import type { Account, AccountId, MidenClient } from "@miden-sdk/miden-sdk";
import {
  addLiquidity,
  collectFees,
  configure,
  removeLiquidity,
  swap,
  type BurnOutput,
  type BurnParams,
  type CollectParams,
  type ConfigureParams,
  type MintOutput,
  type MintParams,
  type OperationOutput,
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

  configure(
    params: ConfigureParams,
    options?: SubmitOptions,
  ): Promise<OperationOutput> {
    return (async () =>
      configure(this.client, this.config, await this.state(), params, options))();
  }
}
