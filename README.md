# port0.sh SDK

TypeScript SDK for the port0.sh constant-product AMM. It wraps
`@miden-sdk/miden-sdk` and owns every Miden-specific step: compiled contract
packages, note script loading, note storage layouts, fee sponsorship notes,
quotes, pool state decoding, pool and registry account creation, and
transaction request assembly.

A pool is a public network account. The pool consumes four XYK notes (`mint`,
`burn`, `swap`, `collect`). The registry consumes two: `register`, and
`registry-collect`, which sweeps the register fees the registry has accumulated.
A pool note travels with a FEE_SPONSORSHIP note that pays the pool's configured
note consumption fee, and the register note is sponsored the same way against
the registry's fee. `registry-collect` is unsponsored and priced at zero, so
the registry pays that transaction's fee from its own vault.

## Install

```sh
npm install @port0.sh/sdk @miden-sdk/miden-sdk
```

The SDK peers on `@miden-sdk/miden-sdk`. Pin the version the testnet runs; see
https://status.testnet.miden.io/.

## Quick start

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";
import { XykClient, deadlineFrom } from "@port0.sh/sdk";

const client = await MidenClient.create({
  rpcUrl: "https://rpc.testnet.miden.io/",
  feeFaucetId: "0x4cbdcaffe75f0a317482224dae6436", // chain fee faucet, required
  proverUrl: "testnet",
  autoSync: false,
});
await client.syncChain();

const xyk = XykClient.from(client);
const pool = xyk.pool({
  poolId,
  feeFaucetId,
  noteFees: { swap: 133n }, // fee schedule fixed at pool creation
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

// result.note, result.sponsorNote, result.request, result.quote,
// result.minAmountOut, result.tokenOut, result.fee, result.feeFaucetId
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
| `SLOT_PREFIX` | `"port0::port0"` | Storage slot name prefix shared by all pool slots. |
| `REGISTRY_SLOT_PREFIX` | `"pool_registry::pool_registry"` | Storage slot name prefix shared by all registry slots. |

`POOL_SLOTS` names the ten exact value slots:

```ts
POOL_SLOTS.token0AssetKey
POOL_SLOTS.token1AssetKey       POOL_SLOTS.lpSupply
POOL_SLOTS.fees                 POOL_SLOTS.p2idRoot
POOL_SLOTS.protocolPot          POOL_SLOTS.price0CumulativeLast
POOL_SLOTS.price1CumulativeLast POOL_SLOTS.blockTimestampLast
POOL_SLOTS.registryId
```

`REGISTRY_SLOTS` names the registry's three maps and four value slots:
`acceptedCodeCommitments`, `pools`, `assetsToPool`, `protocolFeeTo`,
`protocolFeeShareBps`, `allowedLpFeeBps`, `p2idRoot`.

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

amountOut(amountIn, reserveIn, reserveOut, lpFeeBps, protocolFeeShareBps): SwapQuote
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
lp_fee             = floor(lp_fee_bps * amount_in / 10000)
protocol_fee       = floor(protocol_fee_share_bps * lp_fee / 10000)
amount_in_with_fee = amount_in * (10000 - lp_fee_bps)
amount_out         = floor(amount_in_with_fee * reserve_out /
                           (reserve_in * 10000 + amount_in_with_fee))
```

The protocol fee is `lp_fee * protocol_fee_share_bps / 10000`, carved out of the
LP fee, so `amount_out` does not depend on it and the swapper pays the LP fee
tier. The reserve grows by `amount_in - protocol_fee`. Failure order:
`ZeroAmountIn`, `EmptyPool`, `Overflow` (any input above `MAX_AMOUNT`),
`ZeroAmountOut`, `InsufficientLiquidity` (`out >= reserve_out`), `Overflow`
(`reserve_in_after >= MAX_AMOUNT`).

`quoteMint` on the first deposit mints `isqrt(x * y)` LP tokens and retains
`MINIMUM_LIQUIDITY`; on later deposits it mints the smaller of the two
token-contribution ratios, rounds the consumed token amounts up with
`divCeil`, and refunds the unused remainder. It checks `addAmount(reserve,
amount)` against `MAX_AMOUNT` before the ratio branch, so an over-sized deposit
reverts even when part of it would be refunded.

`quoteBurn` returns the proportional share of both reserves. A burn that would
leave less than `MINIMUM_LIQUIDITY` throws `InsufficientLiquidity`, as does a
burn whose payout rounds to zero for either token.

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
| `mintNoteStorage` | 11 | pool, recipient, serial, tag, deadline, `minLpOut` |
| `burnNoteStorage` | 12 | pool, recipient, serial, tag, deadline, `minAmount0`, `minAmount1` |
| `swapNoteStorage` | 11 | pool, recipient, serial, tag, deadline, `minAmountOut` |
| `collectNoteStorage` | 4 | serial |
| `registerNoteStorage` | 8 | registry, pool, asset0, asset1 |
| `registryCollectNoteStorage` | 10 | registry, asset key (4), serial (4) |
| `feeSponsorshipStorage` | 7 | feature note id (4), reclaimer `[suffix, prefix]`, reclaim height |

Account ids inside layouts are `[prefix, suffix]`. The reclaimer in
`feeSponsorshipStorage` is the exception: it is `[suffix, prefix]`, matching
`FeeSponsorshipNoteStorage`.

## Note builders (`notes/build.ts`, `notes/feeSponsorship.ts`)

Each builder returns a web-sdk `Note`. The XYK feature builders produce a public
network note with a `NetworkAccountTarget` attachment to the target account.

```ts
buildMintNote(input: MintNoteInput): Note
buildBurnNote(input: BurnNoteInput): Note
buildSwapNote(input: SwapNoteInput): Note
buildCollectNote(input: CollectNoteInput): Note
buildRegisterNote(input: RegisterNoteInput): Note
buildRegistryCollectNote(input: RegistryCollectNoteInput): Note
buildFeeSponsorshipNote(input: FeeSponsorshipNoteInput): Note

p2idRoot(): Word4
noteScript(kind: NoteKind): NoteScript
POOL_NOTE_KINDS: readonly PoolNoteKind[]  // ["mint","burn","swap","collect"]
NOTE_KINDS: readonly NoteKind[]           // POOL_NOTE_KINDS plus "register" and "registry-collect"
```

Common input fields: `sender`, `poolId`, `recipient` (where applicable),
`deadline` (a block timestamp; the note reverts if the pool executes after it),
and the `min_*` slippage bounds. Defaults applied by the builders: `serial`
defaults to `randomSerial()` and `tag` defaults to `accountTargetTag(recipient)`.

`buildRegisterNote` takes `sender`, `registryId`, `poolId`, `asset0`, and
`asset1`. The produced note targets the registry and carries the 8-felt
register layout and no assets.

`buildRegistryCollectNote` takes `sender`, `registryId`, `assetKey`, and an
optional `serial`. The produced note targets the registry and carries the
10-felt registry-collect layout and no assets.

A registry admits two note kinds, and `createRegistryAccount` prices both in the
network auth it installs: `register` at the caller's `registerFee`, and
`registry-collect` at zero, since collection is permissionless and unsponsored,
so the registry pays that transaction's fee from its own vault. Every admitted
script root must be priced. A root the fee policy does not price aborts fee
estimation, so the node's builder never executes a note running it and the
account's own auth procedure rejects that note as an input. The allowlist is
initial storage of the auth component, and the procedures that mutate it are
gated on an authority this account does not install, so changing the admitted
note kinds means building and deploying a new registry account.

`buildFeeSponsorshipNote` takes `sender`, `target` (the pool or registry),
`featureNote`, `feeFaucetId`, `feeAmount`, and optional `reclaimer` (defaults
to `sender`) and `reclaimHeight` (defaults to `0`, disabled). The produced note
carries exactly one `FungibleAsset(feeFaucetId, feeAmount)` and no attachment.

`noteScript(kind)` deserialises the compiled package from
`src/generated/contracts.ts` once and caches it.

## Transaction request (`notes/request.ts`)

```ts
ownOutputNotesRequest(
  client: MidenClient,
  notes: Note[],
  targetPoolId: AccountId,
): Promise<TransactionRequest>
```

Builds one `TransactionRequest` with `notes` as own output notes, plus the
machinery a wallet-executed multisig request needs:

- A three-word `MultisigAuthArgs` preimage,
  `[boundBlock, 0, 0, 0] || SALT || CONVERSION_INFO` (12 felts), committed with
  `Poseidon2.hashElements` and declared via `withAuthArg`, with the preimage in
  the advice map. `SALT` is fresh per request. `CONVERSION_INFO` is
  `[feeFaucetId.suffix, feeFaucetId.prefix, 1, 1]`, read from
  `client.feeFaucetId()`. The bound block is `client.getSyncHeight()`.
- The target pool as a foreign account with empty storage requirements, so the
  kernel can price the emitted network note through `estimate_note_fee`.

Notes are pushed rather than constructor-consumed so the caller keeps valid
`Note` references. Async because it reads the client sync height and the chain
fee faucet. Emits a feature note and its sponsorship note in one transaction.

```ts
outputNotesRequest(
  client: MidenClient,
  notes: Note[],
  targetAccountId: AccountId,
): Promise<TransactionRequest>
```

The twin for an account whose key the client holds. The wallet variant above
declares the multisig `MultisigAuthArgs` preimage a wallet reads. A local
account signs instead, and the client attaches the signature and the conversion
info it fetched itself. This variant declares no auth args and no block numbers,
and still declares the target account as a foreign account.

Every network note the SDK builds carries `NoteExecutionHint.always()` on its
`NetworkAccountTarget` attachment. A target built without the hint emits
`NoteExecutionHint::None`, which tells the node not to schedule the note, and
the note is never consumed.

## Pool reads (`pool/reads.ts`, `pool/decoding.ts`)

```ts
decodePoolState(account: Account): PoolState
fetchPoolState(getAccount, poolId): Promise<PoolState>
```

`decodePoolState` reads the ten value slots and the vault. Reserves equal the
vault balances of token0 and token1 minus the protocol pot, matching the
contract's `get_reserves`. It throws `NOT_A_POOL` when the token asset keys are
missing or zero, and `INVARIANT` when a vault balance is below the recorded pot.

`PoolState` fields: `accountId`, `token0Key`, `token1Key`, `token0FaucetId`,
`token1FaucetId`, `lpSupply`, `fees` (`lpFeeBps`, `protocolFeeShareBps`),
`registryId`, `p2idRoot`, `protocolPot` (`amount0`, `amount1`),
`price0CumulativeLast`, `price1CumulativeLast`, `blockTimestampLast`,
`reserve0`, `reserve1`. The protocol fee destination is not part of pool state:
it lives on the registry and is read only when the pool collects.

`pool/decoding.ts` exports the individual word decoders: `decodeFeesWord`,
`decodeAccountIdWord`, `decodeScalarWord`, `decodeProtocolPotWord`,
`decodeU128Word`, `isZeroWord4`, `assetKeyToFaucetIdFelts`. The u128 decoder
reads four little-endian 32-bit limbs.

## Pool registry (`pool/registry.ts`)

The registry is a network account that holds the canonical pool set and the
protocol fee policy.

```ts
createRegistryAccount(client, params: CreateRegistryAccountParams): Promise<Account>
deployRegistryAccount(client, registryId, fundingNoteId: string, options?): Promise<TransactionSubmitResult>
registerPool(client, config: RegistryConfig, params: RegisterPoolParams, options?): Promise<RegisterPoolOutput>
readRegistryPools(getAccount, registryId): Promise<RegistryPoolEntry[]>
readRegistryFeePolicy(getAccount, registryId): Promise<RegistryFeePolicy>
readRegistryPoolForAssets(getAccount, registryId, asset0, asset1): Promise<AccountId | null>
readRegistryAcceptedCodeCommitments(getAccount, registryId): Promise<Word4[]>
parseAccountId(value: AccountId | string): AccountId
REGISTRY_SLOTS
```

`CreateRegistryAccountParams` is
`{ acceptedPoolCodeCommitment: string, feeFaucetId: AccountId | string,
registerFee: bigint, protocolFeeTo: AccountId | string,
protocolFeeShareBps: bigint, allowedLpFeeBps: readonly bigint[],
p2idRoot: Word4, seed?: Uint8Array }`. `createRegistryAccount` builds the
registry, seeds `accepted_code_commitments` with the accepted pool code
commitment, seeds `allowed_lp_fee_bps` with the permitted tiers, installs the
network auth with both registry note kinds priced, and inserts the account.
`deployRegistryAccount` consumes a funding note as the first transaction.

`RegistryConfig` is `{ registryId: AccountId, feeFaucetId: AccountId,
registerFee: bigint }`. `RegisterPoolParams` is `{ sender, poolId, asset0,
asset1 }`. `registerPool` builds the register network note and its
FEE_SPONSORSHIP note and assembles one request; the node's transaction builder
consumes the register note against the registry. `RegisterPoolOutput` is
`{ note, sponsorNote, request, fee, feeFaucetId }`.

`readRegistryPools` returns every `{ poolId, codeCommitment }` from the
registry's `pools` map. The node returns at most 1000 entries per map in one
read; a larger map must be paged with `SyncAccountStorageMaps`.

`readRegistryFeePolicy` returns `{ protocolFeeTo, protocolFeeShareBps,
allowedLpFeeBps }`. A pool's fee configuration is frozen at creation and
validated against this policy by `register`.

`readRegistryPoolForAssets` returns the registered pool for an asset pair, or
null. `readRegistryAcceptedCodeCommitments` returns the keys of
`accepted_code_commitments`. `parseAccountId` accepts a hex id with the `0x`
prefix or a bech32 address.

## Pool creation (`pool/create.ts`, `pool/slots.ts`)

```ts
createPoolAccount(client, params: CreatePoolAccountParams): Promise<Account>
buildPoolAccount(client, params: CreatePoolAccountParams): Promise<Account>
poolCodeCommitment(client, params: Omit<CreatePoolAccountParams, "seed">): Promise<string>
deployPoolAccount(client, poolId, fundingNoteId: string, options?: DeployOptions): Promise<TransactionSubmitResult>
createFeeFaucet(client, params: FeeFaucetParams): Promise<Account>
poolInitSlots(params): PoolInitSlotDefinition[]
```

`CreatePoolAccountParams` is `{ token0Key: Word4, token1Key: Word4, registryId:
AccountId, lpFeeBps: bigint, protocolFeeShareBps: bigint, p2idRoot?: Word4,
feeFaucetId: AccountId, noteFees?: PoolNoteFees, seed?: Uint8Array }`.
`PoolNoteFees` is `Partial<Record<PoolNoteKind, bigint>>`. `createPoolAccount`
builds the pool component from the compiled package and the ten init slots,
installs the standard `CodeInspection` component, installs
`AccountComponent.createNetworkAuthComponents` with the fee schedule, and
inserts the account into the client's local store. It does not deploy.

`CodeInspection` exposes `get_code_commitment`,
which the registry calls over FPI to verify the pool code at registration. The
SDK compiles the component through the client's standards library and caches it
per client, so the pool account's code commitment matches the value the
registry accepts.

`buildPoolAccount` builds without inserting, for commitment computation or
offline use. `poolCodeCommitment` returns the pool account code commitment as
lowercase hex, which is the value the registry's `accepted_code_commitments`
map must hold. It is computed through the same path as `createPoolAccount`, so
it cannot drift from a deployed pool. The account seed and the storage values
do not affect it.

`deployPoolAccount` consumes `fundingNoteId` as the pool's first transaction.
A network account rejects a transaction with no effect with
`ERR_NETWORK_ACCOUNT_TRANSACTION_HAS_NO_EFFECT`, so an empty scriptless deploy
fails; consuming a funding note both commits the account and pays its first
transaction fee from the received funds. The pool
is funded first with a small chain fee asset note. The pool id is passed to
`transactions.consume` as a hex string, not as an `AccountId`, because the
client re-parses account references worker-side. `DeployOptions` forwards
`waitForConfirmation`.

`createFeeFaucet` uses `FaucetType.FungibleFaucet` and creates a public
fungible faucet. It is not the pool's network note fee asset: a pool's
`feeFaucetId` must be the chain fee faucet (`client.feeFaucetId()`, USDCX on
the testnet) or the node never consumes the pool's notes. Use this helper
only for application-level faucets, such as a launchpad token.

`poolInitSlots({ token0Key, token1Key, registryId, lpFeeBps,
protocolFeeShareBps, p2idRoot })` returns the ten `PoolInitSlotDefinition`
entries used at account creation.

## Pool config (`pool/config.ts`)

```ts
type PoolConfig = {
  poolId: AccountId;
  feeFaucetId: AccountId;
  noteFees: PoolNoteFees;
  deadlineMarginSeconds?: bigint;
};

noteFee(noteFees: PoolNoteFees, kind: PoolNoteKind): bigint
DEFAULT_DEADLINE_MARGIN_SECONDS   // 3600n
```

`noteFee` returns the configured fee for a kind, or `0n` when unset. The fee
schedule is fixed at pool creation and must be kept by the application for
building correct sponsorship notes.

## Discovery (`pool/discovery.ts`)

```ts
isXykPool(account: Account): boolean
xykNoteScriptRoots(): Record<PoolNoteKind, string>
class PoolRegistry { register(poolId); get(canonicalId); list() }
```

`isXykPool` returns true when the account is a network account whose
note-script allowlist contains all four XYK pool note roots. The node RPC has no
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
registerPool(client, config: RegistryConfig, params: RegisterPoolParams, options?): Promise<RegisterPoolOutput>
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
`RegisterPoolParams`: `sender`, `poolId`, `asset0`, `asset1`.

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
xyk.deployPoolAccount(poolId, fundingNoteId, options?): Promise<TransactionSubmitResult>
xyk.createFeeFaucet(params): Promise<Account>
xyk.createRegistryAccount(params): Promise<Account>
xyk.deployRegistryAccount(registryId, fundingNoteId, options?): Promise<TransactionSubmitResult>
xyk.listRegistryPools(registryId): Promise<RegistryPoolEntry[]>
xyk.listRegistryAccepted(registryId): Promise<Word4[]>
xyk.poolForAssets(registryId, asset0, asset1): Promise<AccountId | null>
xyk.registerPool(config, params, options?): Promise<RegisterPoolOutput>
```

`Pool` binds a `MidenClient` and a `PoolConfig`:

```ts
pool.id: AccountId
pool.state(): Promise<PoolState>
pool.swap(params, options?): Promise<SwapOutput>
pool.addLiquidity(params, options?): Promise<MintOutput>
pool.removeLiquidity(params, options?): Promise<BurnOutput>
pool.collectFees(params, options?): Promise<OperationOutput>
```

`Pool` fetches state internally, so the application calls one method per
action.

## Contract artifacts

```ts
contractPackageBytes(kind: ContractKind): Uint8Array
CONTRACT_KINDS: readonly ContractKind[]
CONTRACT_ARTIFACTS: Record<ContractKind, string>   // base64 .masp
CONTRACT_SHA256: Record<ContractKind, string>
GENERATED_AT: string
wasmModule(): typeof import("@miden-sdk/miden-sdk")
```

`ContractKind` is `"pool" | "registry" | "mint" | "burn" | "swap" | "collect" |
"registry-collect" | "register"`. `wasmModule()` returns the full web-sdk module
on both browser and Node; the Node entry does not re-export the array wrappers
as named exports, and this accessor hides that difference.

# Layout

```
src/
  generated/contracts.ts    compiled .masp packages, base64 (GENERATED)
  constants.ts              pool and registry slot names, math bounds
  artifacts.ts              decode a contract package to bytes
  wasm.ts                   cross-platform web-sdk module accessor
  utils/base64.ts           host-independent base64 decode
  errors.ts                 XykError codes
  math/                     quotes, encoding
  notes/                    layouts, scripts, word, build, feeSponsorship, request
  pool/                     decoding, reads, slots, create, config, discovery, registry
  ops/                      helpers, operations
  client.ts                 XykClient + Pool facade
scripts/
  export-contracts.mjs      regenerates src/generated/contracts.ts
test/
  *.test.ts                 pure unit tests (vitest)
  wasm-smoke.mjs            WASM runtime smoke test (plain Node)
```

# Regenerating artifacts

The generated file embeds the eight compiled Miden packages from the
`port0` contracts workspace. Regenerate it whenever the contracts change:

```sh
npm run generate          # read existing build artifacts
npm run generate:build    # cargo miden build first, then read
```

Override the contracts directory with `PORT0_CONTRACTS_DIR`.

# Build and test

```sh
npm install
npm run typecheck
npm test                  # pure unit tests
npm run build             # emits dist/ (ESM + CJS + d.ts)
npm run test:wasm         # builds, then runs the WASM smoke test in plain Node
npm run pool:commitment   # prints the accepted pool code commitment
npm run registry:deploy   # builds, then creates and deploys the registry account
npm run fees:collect      # builds, then sweeps pool or registry fees
```

`registry:deploy` uses the Node client with its filesystem store under
`~/.miden/stores/<PORT0_STORE>/`. It is interactive: when the operator
wallet is missing or underfunded it prints the address and polls until the
chain fee asset arrives, then builds the registry through
`createRegistryAccount`, funds it, and consumes the funding note. A stored
registry is reused only when it accepts the configured pool code commitment and
admits both registry note kinds; otherwise a fresh registry is deployed. No
re-run is needed. See the script header for the environment variables.

`fees:collect` sweeps protocol fees:

```sh
npm run fees:collect -- registry [--submit]
npm run fees:collect -- pool <pool-id> [--submit]
```

Without `--submit` it is a dry run: it reports what is claimable, the
destination, and the cost to the caller, and submits nothing. Each sweep emits
the collect note and a FEE_SPONSORSHIP note for it. The sponsorship pays the
transaction fee, because a collect note sweeps the whole balance of the asset it
pays out. `PORT0_REGISTRY_ID` and `PORT0_FEE_FAUCET_ID` are required. The caller
is the account named by `PORT0_OPERATOR`, or the first non-network account in
`PORT0_STORE`.

Copy `.env.example` to `.env` and fill it in. The scripts load `.env` from the
repo root; real environment variables take precedence, and a missing file is
not an error.

For the full stack bring-up and the pool deployment flow, see the
[runbook](https://docs.port0.sh/operations/runbook.html).

The WASM smoke test runs as a plain Node process (`test/wasm-smoke.mjs`) rather
than under vitest: the web-sdk native module is unreliable inside vitest's
worker pool.

## Source

Radicle is the canonical source. GitHub and npm are mirrors.

| Source | Location |
| --- | --- |
| Radicle | https://radicle.network/nodes/iris.radicle.network/rad%3Az3qSaS569gAZiHRtjiAuxvrCWzhgp |
| GitHub | https://github.com/port0-sh/port0_sdk |
| npm | https://www.npmjs.com/package/@port0.sh/sdk |
