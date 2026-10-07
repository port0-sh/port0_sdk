# miden-xyk-sdk

TypeScript SDK for the MidenXYK constant-product AMM. It wraps
`@miden-sdk/miden-sdk` and owns every Miden-specific step: compiled contract
packages, note script loading, note storage layouts, fee sponsorship notes,
quotes, pool state decoding, pool account creation, and transaction request
assembly.

A pool is a public network account. Each of the five XYK notes (admin, mint,
burn, swap, collect) is a public network note carrying a `NetworkAccountTarget`
attachment bound to the pool. Each note travels with a FEE_SPONSORSHIP note
that pays the pool's configured note consumption fee. The end user pays that
fee in the pool's fee faucet asset.

## Install

```
npm install miden-xyk-sdk @miden-sdk/miden-sdk@0.17.0
```

The SDK pins `@miden-sdk/miden-sdk` to `0.17.0`.

## Quick start

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";
import { XykClient, deadlineFrom } from "miden-xyk-sdk";

const client = await MidenClient.create({ rpcUrl: "https://rpc.testnet.miden.io/" });
await client.sync();

const xyk = XykClient.from(client);
const pool = xyk.pool({
  poolId,
  feeFaucetId,
  noteFees: { swap: 5n },   // fee schedule fixed at pool creation
});

const state = await pool.state();

const result = await pool.swap({
  sender,
  recipient,
  tokenIn: token0,
  amountIn: 1000n,
  slippageBps: 50n,
  deadline: deadlineFrom(latestBlockTimestamp, 3600n),
  // submit: true, waitForConfirmation: true,
});

// result.note, result.sponsorNote, result.request, result.quote, result.minAmountOut, result.fee
```

# API

All amounts are `bigint` and denominated in the smallest unit of the relevant
asset. All account ids are the web-sdk `AccountId` type unless stated
otherwise. `Word4` and `SerialNumber` are four-limb tuples:

```ts
type Word4 = readonly [bigint, bigint, bigint, bigint];
type SerialNumber = Word4;
```

## Constants

| Name | Value | Meaning |
|------|-------|---------|
| `MAX_AMOUNT` | `1n << 57n` | Upper bound on every reserve, amount, and `lp_supply`. |
| `MINIMUM_LIQUIDITY` | `1000n` | LP tokens locked permanently on the first mint. |
| `FEE_DENOMINATOR` | `10_000n` | Basis-point denominator for both fees. |
| `SLOT_PREFIX` | `"miden_xyk::miden_xyk"` | Storage slot name prefix shared by all pool slots. |

`POOL_SLOTS` is an object with the eleven exact value-slot names:

```ts
POOL_SLOTS.tokenlpAssetKey     POOL_SLOTS.token0AssetKey
POOL_SLOTS.token1AssetKey      POOL_SLOTS.lpSupply
POOL_SLOTS.fees                POOL_SLOTS.admin
POOL_SLOTS.p2idRoot            POOL_SLOTS.protocolPot
POOL_SLOTS.price0CumulativeLast POOL_SLOTS.price1CumulativeLast
POOL_SLOTS.blockTimestampLast
```

## Errors

`PoolMathError` is thrown by the pure math functions. Its `kind` is one of
`EmptyPool`, `Overflow`, `ZeroAmountIn`, `ZeroAmountOut`,
`InsufficientLiquidity`, `Invariant`. The message string matches the contract's
`PoolMathError`.

`XykError` is thrown by the SDK layer above the math. Its `code` is one of
`NOT_A_POOL`, `POOL_NOT_FOUND`, `POOL_NOT_CONFIGURED`, `MISSING_SLOT`,
`INVARIANT`, `INVALID_ARGUMENT`, `UNSUPPORTED_OPERATION`.

## Pure math (`math/quotes.ts`)

These functions have no WASM dependency and mirror the contract arithmetic
exactly, including check order and rounding.

```ts
isqrt(n: bigint): bigint
divCeil(numerator: bigint, denominator: bigint): bigint

amountOut(amountIn, reserveIn, reserveOut, lpFeeBps, protocolFeeBps): SwapQuote
quoteMint(amount0, amount1, reserve0, reserve1, lpSupply): MintQuote
quoteBurn(amountToBurn, reserve0, reserve1, lpSupply): BurnQuote
```

`SwapQuote` is `{ amountOut, reserveInAfter, reserveOutAfter, protocolFee }`.

`MintQuote` is `{ liquidityToUser, lpSupplyAfter, reserve0After,
reserve1After, refund0, refund1 }`.

`BurnQuote` is `{ amount0, amount1, lpSupplyAfter, reserve0After,
reserve1After }`.

`amountOut` computes, in order:

```
protocol_fee = floor(protocol_fee_bps * amount_in / 10000)
lp_amount    = amount_in - protocol_fee
amount_in_with_fee = lp_amount * (10000 - lp_fee_bps)
amount_out   = floor(amount_in_with_fee * reserve_out /
                     (reserve_in * 10000 + amount_in_with_fee))
```

The protocol fee is taken from the input first; the LP fee applies to the
remainder. Failure order: `ZeroAmountIn`, `EmptyPool`, `Overflow` (any input
above `MAX_AMOUNT`), `ZeroAmountOut`, `InsufficientLiquidity` (`out >=
reserve_out`), `Overflow` (`reserve_in_after >= MAX_AMOUNT`).

`quoteMint` on the first deposit mints `isqrt(x * y)` LP tokens and retains
`MINIMUM_LIQUIDITY`; on later deposits it mints the smaller of the two
token-contribution ratios, rounds the consumed token amounts up with
`divCeil`, and refunds the unused remainder. It checks `add_amount(reserve,
amount)` against `MAX_AMOUNT` before the ratio branch, so an over-sized deposit
reverts even when part of it would be refunded.

`quoteBurn` returns the proportional share of both reserves. A burn that would
leave less than `MINIMUM_LIQUIDITY` throws `InsufficientLiquidity`.

## Encoders (`math/encoding.ts`)

```ts
accountIdFelts(id): [bigint, bigint]          // [prefix, suffix]
fungibleAssetIdWord(faucetId): Word4          // [0, 0, suffix | 0x11, prefix]
accountTargetTag(id): bigint                  // top 14 prefix bits, low bits zeroed
randomSerial(): SerialNumber
randomSeed(): Uint8Array                      // 32 bytes
isWord4(value): value is Word4
ACCOUNT_TARGET_TAG_LEN                        // 14
```

`AccountIdLike` is the structural account id accepted by the encoders:

```ts
type AccountIdLike = {
  prefix(): { asInt(): bigint };
  suffix(): { asInt(): bigint };
};
```

The web-sdk `AccountId` satisfies it. `accountTargetTag` is computed entirely
in `bigint`; using JS `number` bitwise operators would truncate to int32 and
produce a negative tag whenever bit 31 of the prefix is set.

## Note storage layouts (`notes/layouts.ts`)

Each function returns `bigint[]` in the exact order the note script asserts.

| Function | Felts | Layout |
|----------|-------|--------|
| `mintNoteStorage` | 11 | pool, recipient, serial, tag, deadline, `min_lp_out` |
| `burnNoteStorage` | 12 | pool, recipient, serial, tag, deadline, `min_amount0`, `min_amount1` |
| `swapNoteStorage` | 11 | pool, recipient, serial, tag, deadline, `min_amount_out` |
| `collectNoteStorage` | 4 | serial |
| `adminNoteStorage` | 14 | pool, `protocol_fee_to`, `lp_fee_bps`, `protocol_fee_bps`, `p2id_root`, `lp_key` |
| `feeSponsorshipStorage` | 7 | feature note id, reclaimer `[suffix, prefix]`, reclaim height |

Account ids inside layouts are `[prefix, suffix]`. The reclaimer in
`feeSponsorshipStorage` is the exception: it is `[suffix, prefix]`, matching
`FeeSponsorshipNoteStorage`.

## Note builders (`notes/build.ts`, `notes/feeSponsorship.ts`)

Each builder returns a web-sdk `Note` and produces a public network note with a
`NetworkAccountTarget` attachment to the pool.

```ts
buildMintNote(input: MintNoteInput): Note
buildBurnNote(input: BurnNoteInput): Note
buildSwapNote(input: SwapNoteInput): Note
buildCollectNote(input: CollectNoteInput): Note
buildAdminNote(input: AdminNoteInput): Note
buildFeeSponsorshipNote(input: FeeSponsorshipNoteInput): Note

p2idRoot(): Word4
noteScript(kind: NoteKind): NoteScript
NOTE_KINDS: readonly NoteKind[]   // ["admin","mint","burn","swap","collect"]
```

Common input fields: `sender`, `poolId`, `recipient` (where applicable),
`deadline` (a block timestamp; the note reverts if the pool executes after it),
and the `min_*` slippage bounds. Defaults applied by the builders: `serial`
defaults to `randomSerial()`, `tag` defaults to `accountTargetTag(recipient)`,
the admin note's `p2idRoot` defaults to `NoteScript.p2id().root()`, and its
`lpKey` defaults to `fungibleAssetIdWord(poolId)`.

`buildFeeSponsorshipNote` takes `sender`, `target` (the pool), `featureNote`,
`feeFaucetId`, `feeAmount`, and optional `reclaimer` (defaults to `sender`) and
`reclaimHeight` (defaults to `0`, disabled). The produced note carries exactly
one `FungibleAsset(feeFaucetId, feeAmount)` and no attachment.

`noteScript(kind)` deserialises the compiled package from
`src/generated/contracts.ts` once and caches it.

## Transaction request (`notes/request.ts`)

```ts
ownOutputNotesRequest(notes: Note[]): TransactionRequest
```

Builds one `TransactionRequestBuilder` with `notes` as own output notes,
pushed rather than constructor-consumed so the caller keeps valid `Note`
references. Used to emit a feature note and its sponsorship note in one
transaction.

## Pool reads (`pool/reads.ts`, `pool/decoding.ts`)

```ts
decodePoolState(account: Account): PoolState
fetchPoolState(getAccount, poolId): Promise<PoolState>
```

`decodePoolState` reads the eleven value slots and the vault. Reserves equal
the vault balances of token0 and token1 minus the protocol pot, matching the
contract's `get_reserves`. It throws `NOT_A_POOL` when the token asset keys are
missing or zero, and `INVARIANT` when a vault balance is below the recorded
pot.

`PoolState` fields: `accountId`, `configured`, `token0Key`, `token1Key`,
`lpKey`, `token0FaucetId`, `token1FaucetId`, `lpSupply`, `fees` (`lpFeeBps`,
`protocolFeeBps`, `feeTo`), `admin`, `p2idRoot`, `protocolPot` (`amount0`,
`amount1`), `price0CumulativeLast`, `price1CumulativeLast`,
`blockTimestampLast`, `reserve0`, `reserve1`.

`pool/decoding.ts` exports the individual word decoders: `decodeFeesWord`,
`decodeAdminWord`, `decodeScalarWord`, `decodeProtocolPotWord`,
`decodeU128Word`, `isZeroWord4`, `assetKeyToFaucetIdFelts`. The u128 decoder
reads four little-endian 32-bit limbs.

## Pool creation (`pool/create.ts`, `pool/slots.ts`)

```ts
createPoolAccount(client, params: CreatePoolAccountParams): Promise<Account>
deployPoolAccount(client, poolId, options?: DeployOptions): Promise<TransactionSubmitResult>
createFeeFaucet(client, params: FeeFaucetParams): Promise<Account>
```

`CreatePoolAccountParams` is `{ token0Key: Word4, token1Key: Word4, admin:
AccountId, feeFaucetId: AccountId, noteFees?: PoolNoteFees, seed?: Uint8Array }`.
`PoolNoteFees` is `Partial<Record<NoteKind, bigint>>`. `createPoolAccount`
builds the pool component from the compiled package and the eleven init slots,
installs `AccountComponent.createNetworkAuthComponents` with the fee schedule,
and inserts the account into the client's local store. It does not deploy.

`deployPoolAccount` submits a scriptless (empty) transaction. The network auth
forbids tx scripts and bumps the nonce itself, so an empty request commits the
account. `DeployOptions.waitForConfirmation` polls `transactions.waitFor`.

`createFeeFaucet` uses `FaucetType.FungibleFaucet`. The faucet is public. The
caller must later fund the pool and the users with this faucet's asset.

`poolInitSlots({ token0Key, token1Key, admin })` returns the eleven
`PoolInitSlotDefinition` entries used at account creation.

## Pool config (`pool/config.ts`)

```ts
type PoolConfig = {
  poolId: AccountId;
  feeFaucetId: AccountId;
  noteFees: PoolNoteFees;
  deadlineMarginSeconds?: bigint;
};

noteFee(noteFees: PoolNoteFees, kind: NoteKind): bigint
DEFAULT_DEADLINE_MARGIN_SECONDS   // 3600n
```

`noteFee` returns the configured fee for a kind, or `0n` when unset. The fee
schedule is fixed at pool creation and must be kept by the application for
building correct sponsorship notes.

## Discovery (`pool/discovery.ts`)

```ts
isXykPool(account: Account): boolean
xykNoteScriptRoots(): Record<NoteKind, string>
class PoolRegistry { register(poolId); get(canonicalId); list() }
```

`isXykPool` returns true when the account is a network account whose
note-script allowlist contains all five XYK note roots. The node RPC has no
account-listing-by-code-root endpoint, so chain-wide discovery is left to the
product's indexer; `PoolRegistry` holds the pool ids the application knows.

## Operations (`ops/operations.ts`, `ops/helpers.ts`)

Each operation has the shape `(client, config, state, params, options?)` and
runs the local quote, applies the slippage bound, builds the feature note and
its sponsorship note, and assembles the combined request.

```ts
swap(client, config, state, params: SwapParams, options?): Promise<SwapOutput>
addLiquidity(client, config, state, params: MintParams, options?): Promise<MintOutput>
removeLiquidity(client, config, state, params: BurnParams, options?): Promise<BurnOutput>
collectFees(client, config, state, params: CollectParams, options?): Promise<OperationOutput>
configure(client, config, state, params: ConfigureParams, options?): Promise<OperationOutput>
```

`OperationOutput` is `{ note, sponsorNote, request, fee, feeFaucetId }`.
`SwapOutput` adds `{ quote, tokenOut, minAmountOut }`. `MintOutput` adds
`{ quote, minLpOut }`. `BurnOutput` adds `{ quote, minAmount0, minAmount1 }`.

`SubmitOptions` is `{ submit?: boolean, waitForConfirmation?: boolean }`.
`submit` defaults to `false`, so the caller receives the request and hands it
to a wallet adapter; set `submit: true` to send it through the `MidenClient`.

`SwapParams`: `sender`, `recipient`, `tokenIn`, `amountIn`, `slippageBps`,
`deadline`, optional `serial`, `tag`. `MintParams`: `sender`, `recipient`,
`amount0`, `amount1`, `slippageBps`, `deadline`, optional `serial`, `tag`.
`BurnParams`: `sender`, `recipient`, `amountLp`, `slippageBps`, `deadline`,
optional `serial`, `tag`. `CollectParams`: `sender`, optional `serial`.
`ConfigureParams`: `sender`, `feeTo`, `lpFeeBps`, `protocolFeeBps`.

Helpers:

```ts
applySlippage(amount: bigint, slippageBps: bigint): bigint
resolveSwapSide(tokenIn: string, token0: string, token1: string): 0 | 1
deadlineFrom(blockTimestampSeconds: bigint, marginSeconds: bigint): bigint
```

`applySlippage` returns `floor(amount * (10000 - slippageBps) / 10000)` and
throws `INVALID_ARGUMENT` for `slippageBps` outside `[0, 10000)`.
`resolveSwapSide` throws `INVALID_ARGUMENT` when `tokenIn` matches neither
side. `deadlineFrom` is `blockTimestampSeconds + marginSeconds`.

## Facade (`client.ts`)

```ts
XykClient.from(client: MidenClient): XykClient

xyk.pool(config: PoolConfig): Pool
xyk.createPoolAccount(params): Promise<Account>
xyk.deployPoolAccount(poolId, options?): Promise<TransactionSubmitResult>
xyk.createFeeFaucet(params): Promise<Account>
```

`Pool` binds a `MidenClient` and a `PoolConfig`:

```ts
pool.id: AccountId
pool.state(): Promise<PoolState>
pool.swap(params, options?): Promise<SwapOutput>
pool.addLiquidity(params, options?): Promise<MintOutput>
pool.removeLiquidity(params, options?): Promise<BurnOutput>
pool.collectFees(params, options?): Promise<OperationOutput>
pool.configure(params, options?): Promise<OperationOutput>
```

`Pool` fetches state internally, so the application calls one method per
action.

## Contract artifacts

```ts
contractPackageBytes(kind: ContractKind): Uint8Array
CONTRACT_KINDS: readonly ContractKind[]
CONTRACT_ARTIFACTS: Record<ContractKind, string>   // base64 .masp
CONTRACT_SHA256: Record<ContractKind, string>
wasmModule(): typeof import("@miden-sdk/miden-sdk")
```

`ContractKind` is `"pool" | "admin" | "mint" | "burn" | "swap" | "collect"`.
`wasmModule()` returns the full web-sdk module on both browser and Node; the
Node entry does not re-export the array wrappers as named exports in 0.16, and
this accessor hides that difference.

# Layout

```
src/
  generated/contracts.ts    compiled .masp packages, base64 (GENERATED)
  constants.ts              pool slot names and math bounds
  artifacts.ts              decode a contract package to bytes
  wasm.ts                   cross-platform web-sdk module accessor
  utils/base64.ts           host-independent base64 decode
  errors.ts                 XykError codes
  math/                     quotes, encoding
  notes/                    layouts, scripts, word, build, feeSponsorship, request
  pool/                     decoding, reads, slots, create, config, discovery
  ops/                      helpers, operations
  client.ts                 XykClient + Pool facade
scripts/
  export-contracts.mjs      regenerates src/generated/contracts.ts
test/
  *.test.ts                 pure unit tests (vitest)
  wasm-smoke.mjs            WASM runtime smoke test (plain Node)
```

# Regenerating artifacts

The generated file embeds the six compiled Miden packages from
`../miden_xyk/contracts`. Regenerate it whenever the contracts change:

```sh
npm run generate          # read existing build artifacts
npm run generate:build    # cargo miden build first, then read
```

Override the contracts directory with `MIDEN_XYK_CONTRACTS_DIR`.

# Build and test

```sh
npm install
npm run typecheck
npm test                  # pure unit tests
npm run build             # emits dist/ (ESM + CJS + d.ts)
npm run test:wasm         # builds, then runs the WASM smoke test in plain Node
```

The WASM smoke test runs as a plain Node process (`test/wasm-smoke.mjs`) rather
than under vitest: the web-sdk native module is unreliable inside vitest's
worker pool.
