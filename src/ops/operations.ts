/**
 * High-level pool operations.
 *
 * Each operation: runs the local quote, applies the slippage bound, builds the
 * XYK network note and its FEE_SPONSORSHIP note, and assembles a single
 * transaction request emitting both. With `submit: true` it submits the
 * request from the sender account; otherwise the caller receives the request
 * to hand to a wallet adapter.
 */
import {
  AccountId,
  Note,
  TransactionRequest,
  type MidenClient,
} from "@miden-sdk/miden-sdk";
import type {
  BurnQuote,
  MintQuote,
  SwapQuote,
} from "../math/quotes.js";
import { amountOut, quoteBurn, quoteMint } from "../math/quotes.js";
import type { SerialNumber, Word4 } from "../math/encoding.js";
import { XykError } from "../errors.js";
import { MAX_TX_FEE } from "../constants.js";
import {
  buildBurnNote,
  buildCollectNote,
  buildMintNote,
  buildRegisterNote,
  buildSwapNote,
} from "../notes/build.js";
import { buildFeeSponsorshipNote } from "../notes/feeSponsorship.js";
import { ownOutputNotesRequest } from "../notes/request.js";
import { noteFee, type PoolConfig } from "../pool/config.js";
import type { PoolState } from "../pool/reads.js";
import { applySlippage, resolveSwapSide } from "./helpers.js";

export interface SubmitOptions {
  /** When true, submit the request from `sender`. Defaults to false (build-only). */
  submit?: boolean;
  /** Poll until the submitted transaction is confirmed. */
  waitForConfirmation?: boolean;
}

export interface OperationOutput {
  note: Note;
  sponsorNote: Note;
  request: TransactionRequest;
  fee: bigint;
  feeFaucetId: AccountId;
}

function assertPool(state: PoolState, config: PoolConfig): void {
  if (state.accountId.toString() !== config.poolId.toString()) {
    throw new XykError(
      "INVALID_ARGUMENT",
      "pool state and pool config refer to different accounts",
    );
  }
}

function sponsor(
  config: PoolConfig,
  sender: AccountId,
  featureNote: Note,
  kind: "mint" | "burn" | "swap" | "collect",
): { sponsorNote: Note; fee: bigint } {
  // Floor at the protocol maximum: a note can cost up to it, and the executing
  // account must hold the actual fee at the epilogue. The surplus is swept by a
  // later collect.
  const configured = noteFee(config.noteFees, kind);
  const fee = configured > MAX_TX_FEE ? configured : MAX_TX_FEE;
  const sponsorNote = buildFeeSponsorshipNote({
    sender,
    target: config.poolId,
    featureNote,
    feeFaucetId: config.feeFaucetId,
    feeAmount: fee,
  });
  return { sponsorNote, fee };
}

async function submitIfRequested(
  client: MidenClient,
  sender: AccountId,
  request: TransactionRequest,
  options?: SubmitOptions,
): Promise<void> {
  if (!options?.submit) {
    return;
  }
  const result = await client.transactions.submit(sender, request);
  if (options.waitForConfirmation) {
    await client.transactions.waitFor(result.txId);
  }
}

export interface SwapParams {
  sender: AccountId;
  recipient: AccountId;
  /** Faucet of the token being swapped in (must be token0 or token1). */
  tokenIn: AccountId;
  amountIn: bigint;
  /** Slippage bound in basis points, [0, 10000). */
  slippageBps: bigint;
  deadline: bigint;
  serial?: SerialNumber;
  tag?: bigint;
}

export interface SwapOutput extends OperationOutput {
  quote: SwapQuote;
  tokenOut: AccountId;
  minAmountOut: bigint;
}

export function swap(
  client: MidenClient,
  config: PoolConfig,
  state: PoolState,
  params: SwapParams,
  options?: SubmitOptions,
): Promise<SwapOutput> {
  assertPool(state, config);
  const tokenIn = params.tokenIn.toString();
  const side = resolveSwapSide(
    tokenIn,
    state.token0FaucetId.toString(),
    state.token1FaucetId.toString(),
  );
  const reserveIn = side === 0 ? state.reserve0 : state.reserve1;
  const reserveOut = side === 0 ? state.reserve1 : state.reserve0;
  const tokenOut = side === 0 ? state.token1FaucetId : state.token0FaucetId;

  const quote = amountOut(
    params.amountIn,
    reserveIn,
    reserveOut,
    state.fees.lpFeeBps,
    state.fees.protocolFeeShareBps,
  );
  const minAmountOut = applySlippage(quote.amountOut, params.slippageBps);

  const note = buildSwapNote({
    sender: params.sender,
    poolId: config.poolId,
    recipient: params.recipient,
    tokenIn: params.tokenIn,
    amountIn: params.amountIn,
    minAmountOut,
    deadline: params.deadline,
    serial: params.serial,
    tag: params.tag,
  });
  const { sponsorNote, fee } = sponsor(config, params.sender, note, "swap");
  return (async () => {
    const request = await ownOutputNotesRequest(
      client,
      [note, sponsorNote],
      config.poolId,
    );
    await submitIfRequested(client, params.sender, request, options);
    return {
      note,
      sponsorNote,
      request,
      quote,
      tokenOut,
      minAmountOut,
      fee,
      feeFaucetId: config.feeFaucetId,
    };
  })();
}

export interface MintParams {
  sender: AccountId;
  recipient: AccountId;
  amount0: bigint;
  amount1: bigint;
  slippageBps: bigint;
  deadline: bigint;
  serial?: SerialNumber;
  tag?: bigint;
}

export interface MintOutput extends OperationOutput {
  quote: MintQuote;
  minLpOut: bigint;
}

export function addLiquidity(
  client: MidenClient,
  config: PoolConfig,
  state: PoolState,
  params: MintParams,
  options?: SubmitOptions,
): Promise<MintOutput> {
  assertPool(state, config);
  const quote = quoteMint(
    params.amount0,
    params.amount1,
    state.reserve0,
    state.reserve1,
    state.lpSupply,
  );
  const minLpOut = applySlippage(quote.liquidityToUser, params.slippageBps);

  const note = buildMintNote({
    sender: params.sender,
    poolId: config.poolId,
    recipient: params.recipient,
    token0: state.token0FaucetId,
    token1: state.token1FaucetId,
    amount0: params.amount0,
    amount1: params.amount1,
    minLpOut,
    deadline: params.deadline,
    serial: params.serial,
    tag: params.tag,
  });
  const { sponsorNote, fee } = sponsor(config, params.sender, note, "mint");
  return (async () => {
    const request = await ownOutputNotesRequest(
      client,
      [note, sponsorNote],
      config.poolId,
    );
    await submitIfRequested(client, params.sender, request, options);
    return {
      note,
      sponsorNote,
      request,
      quote,
      minLpOut,
      fee,
      feeFaucetId: config.feeFaucetId,
    };
  })();
}

export interface BurnParams {
  sender: AccountId;
  recipient: AccountId;
  /** LP tokens to burn. */
  amountLp: bigint;
  slippageBps: bigint;
  deadline: bigint;
  serial?: SerialNumber;
  tag?: bigint;
}

export interface BurnOutput extends OperationOutput {
  quote: BurnQuote;
  minAmount0: bigint;
  minAmount1: bigint;
}

export function removeLiquidity(
  client: MidenClient,
  config: PoolConfig,
  state: PoolState,
  params: BurnParams,
  options?: SubmitOptions,
): Promise<BurnOutput> {
  assertPool(state, config);
  const quote = quoteBurn(
    params.amountLp,
    state.reserve0,
    state.reserve1,
    state.lpSupply,
  );
  const minAmount0 = applySlippage(quote.amount0, params.slippageBps);
  const minAmount1 = applySlippage(quote.amount1, params.slippageBps);

  const note = buildBurnNote({
    sender: params.sender,
    poolId: config.poolId,
    recipient: params.recipient,
    amountLp: params.amountLp,
    minAmount0,
    minAmount1,
    deadline: params.deadline,
    serial: params.serial,
    tag: params.tag,
  });
  const { sponsorNote, fee } = sponsor(config, params.sender, note, "burn");
  return (async () => {
    const request = await ownOutputNotesRequest(
      client,
      [note, sponsorNote],
      config.poolId,
    );
    await submitIfRequested(client, params.sender, request, options);
    return {
      note,
      sponsorNote,
      request,
      quote,
      minAmount0,
      minAmount1,
      fee,
      feeFaucetId: config.feeFaucetId,
    };
  })();
}

export interface CollectParams {
  /** The fee recipient account sending the note. */
  sender: AccountId;
  /**
   * Asset keys to sweep. Defaults to every fungible asset the pool's vault
   * holds: token0 and token1 pay the protocol pot plus any credit outside the
   * reserves, and any third asset is paid in full.
   */
  assetKeys?: readonly Word4[];
  serial?: SerialNumber;
}

export function collectFees(
  client: MidenClient,
  config: PoolConfig,
  state: PoolState,
  params: CollectParams,
  options?: SubmitOptions,
): Promise<OperationOutput> {
  assertPool(state, config);
  const note = buildCollectNote({
    sender: params.sender,
    poolId: config.poolId,
    assetKeys: params.assetKeys ?? state.vaultAssetKeys,
    serial: params.serial,
  });
  const { sponsorNote, fee } = sponsor(config, params.sender, note, "collect");
  return (async () => {
    const request = await ownOutputNotesRequest(
      client,
      [note, sponsorNote],
      config.poolId,
    );
    await submitIfRequested(client, params.sender, request, options);
    return {
      note,
      sponsorNote,
      request,
      fee,
      feeFaucetId: config.feeFaucetId,
    };
  })();
}

export interface RegistryConfig {
  /** Registry (network account) the register note targets. */
  registryId: AccountId;
  /** Faucet whose asset denominates the register note fee. */
  feeFaucetId: AccountId;
  /** Consumption fee for the register note, fixed at registry creation. */
  registerFee: bigint;
}

export interface RegisterPoolParams {
  /** Account emitting the register note. */
  sender: AccountId;
  /** Pool being registered. */
  poolId: AccountId;
  /** First token of the pool pair. */
  asset0: AccountId;
  /** Second token of the pool pair. */
  asset1: AccountId;
}

export interface RegisterPoolOutput {
  note: Note;
  sponsorNote: Note;
  request: TransactionRequest;
  fee: bigint;
  feeFaucetId: AccountId;
}

/**
 * Emits the register note and its sponsorship note for a pool. The node's
 * transaction builder consumes the register note against the registry; the
 * registry then verifies the pool code commitment by FPI.
 */
export function registerPool(
  client: MidenClient,
  config: RegistryConfig,
  params: RegisterPoolParams,
  options?: SubmitOptions,
): Promise<RegisterPoolOutput> {
  const note = buildRegisterNote({
    sender: params.sender,
    registryId: config.registryId,
    poolId: params.poolId,
    asset0: params.asset0,
    asset1: params.asset1,
  });
  // Floor at the protocol maximum; the register transaction runs foreign calls
  // and can cost more than the configured note fee.
  const fee = config.registerFee > MAX_TX_FEE ? config.registerFee : MAX_TX_FEE;
  const sponsorNote = buildFeeSponsorshipNote({
    sender: params.sender,
    target: config.registryId,
    featureNote: note,
    feeFaucetId: config.feeFaucetId,
    feeAmount: fee,
  });
  return (async () => {
    const request = await ownOutputNotesRequest(
      client,
      [note, sponsorNote],
      config.registryId,
    );
    await submitIfRequested(client, params.sender, request, options);
    return {
      note,
      sponsorNote,
      request,
      fee,
      feeFaucetId: config.feeFaucetId,
    };
  })();
}
