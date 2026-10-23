# port0.sh SDK

TypeScript SDK for the port0.sh constant-product AMM on Miden. It builds the
network notes, fee sponsorships, quotes, and transaction requests that pools and
the pool registry execute, and reads their on-chain state.

Every amount is `bigint` in base units. The math is a direct port of the contracts
in [`port0_contracts`](https://github.com/port0-sh/port0_contracts), with the same
rounding and the same failure conditions.

## Install

```sh
npm install @port0.sh/sdk @miden-sdk/miden-sdk
```

The SDK peers on `@miden-sdk/miden-sdk@^0.17.6`, the version its `dist` is built
and tested against. A client talks only to a node of the same major.minor.

## Quick start

```ts
import { MidenClient } from '@miden-sdk/miden-sdk'
import { XykClient, fetchPoolState, NOTE_FEES } from '@port0.sh/sdk'

const client = await MidenClient.create({ rpcUrl: 'https://rpc.testnet.miden.io' })
const xyk = XykClient.from(client)
const pool = xyk.pool({ poolId, feeFaucetId, noteFees: NOTE_FEES })

const state = await fetchPoolState((id) => client.accounts.get(id), poolId)
const out = await pool.swap({
  sender,
  recipient: sender,
  tokenIn,
  amountIn: 1_000_000n,
  slippageBps: 50n,
  deadline: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
})
// `out.request` is a TransactionRequest. With `{ submit: true }` the client
// submits it; otherwise hand it to a wallet adapter.
await client.transactions.submit(sender, out.request)
```

## API

Exports are grouped as the modules are. Everything below is re-exported from the
package root.

### Constants (`constants.ts`)

| Export | Value or meaning |
| --- | --- |
| `MAX_AMOUNT` | `2^57`, the AMM's amount bound |
| `MINIMUM_LIQUIDITY` | `1000n`, LP tokens locked by the first mint |
| `FEE_DENOMINATOR` | `10000n`, the bps denominator |
| `MAX_TX_FEE` | `210n`, the largest fee the kernel can charge at base fee 7; scripts size funding with it, never a note price |
| `NOTE_FEES` | Schedule price per note kind: `126` for `mint`, `burn`, `swap`, `collect`; `119` for `register`, `registry-collect`, `launch`; `0` for `registry-config` |
| `POOL_SLOTS`, `REGISTRY_SLOTS`, `POOL_AUTH_SLOTS` | Storage slot names the contracts use |
| `SLOT_PREFIX`, `REGISTRY_SLOT_PREFIX` | Slot name prefixes |
| `POOL_COLLECT_FEE_HOLD`, `REGISTRY_COLLECT_FEE_HOLD`, `COLLECT_MAX_KEYS` | Generated from the contracts' `collect-fee-hold.rs` |

`NOTE_FEES` is measured by `cargo test -p integration --release note_fee_benchmark`
at verification base fee 7: the kernel fee for the most expensive path plus the
pricer's one-cycle margin. Regenerate it when a note script's cycle count changes.

### Pure math (`math/quotes.ts`)

| Export | Result |
| --- | --- |
| `isqrt`, `divCeil` | Integer helpers with the contracts' rounding |
| `amountOut(tokenInIs0, amountIn, reserveIn, reserveOut, lpFeeBps, protocolFeeShareBps)` | `{ amountOut, reserveInAfter, reserveOutAfter, protocolFee }` |
| `quoteMint(amount0, amount1, reserve0, reserve1, lpSupply)` | `{ liquidityToUser, lpSupplyAfter, reserve0After, reserve1After, refund0, refund1 }` |
| `quoteBurn(lpAmount, reserve0, reserve1, lpSupply)` | `{ amount0, amount1, lpSupplyAfter, reserve0After, reserve1After }` |
| `PoolMathError`, `PoolMathErrorKind` | The contracts' failure conditions |

The protocol's share is carved out of the LP fee, so the swap output does not
depend on it.

### Encoders (`math/encoding.ts`)

`accountIdFelts`, `fungibleAssetIdWord`, `accountTargetTag`, `randomSerial`,
`randomSeed`, `isWord4`, and the `Word4`, `SerialNumber`, `AccountIdLike` types.
Account ids are `[prefix, suffix]`; the account-target tag is the top 14 bits of the
prefix's high word.

### Note storage layouts (`notes/layouts.ts`)

`mintNoteStorage`, `burnNoteStorage`, `swapNoteStorage`, `collectNoteStorage`,
`registryCollectNoteStorage`, `registerNoteStorage`. Pure functions, WASM-free, so
they are unit-tested against the lengths the scripts assert.

### Note builders (`notes/build.ts`, `notes/feeSponsorship.ts`)

Every builder returns a public note carrying a `NetworkAccountTarget` attachment to
the account that must consume it, except the sponsorship note, which has none.

| Builder | Target | Assets | Storage |
| --- | --- | --- | --- |
| `buildMintNote` | pool | token0 and token1 | pool, recipient, serial, tag, `minLpOut`, deadline |
| `buildBurnNote` | pool | LP token | pool, recipient, serial, tag, `minToken0Out`, `minToken1Out`, deadline |
| `buildSwapNote` | pool | token in | pool, recipient, serial, tag, `minAmountOut`, deadline |
| `buildCollectNote` | pool | none | pool, serial, asset keys |
| `buildRegisterNote` | registry | none | registry, pool, asset0, asset1 |
| `buildRegistryCollectNote` | registry | none | registry, serial, asset keys |
| `buildRegistryConfigNote` | registry | none | registry, new register fee, register note root |
| `buildLaunchNote` | network faucet | none | faucet, recipient, serial, tag |
| `buildFeeSponsorshipNote` | pool or registry | one fungible asset | feature note id, reclaimer, reclaim height |

`serial` defaults to `randomSerial()` and `tag` to `accountTargetTag(recipient)`.
A deadline is a block timestamp; the pool reverts if it executes after it.

Two rules the layouts do not show: a pool collect must name token0 and token1 to
pay the protocol pot, because a pool cannot enumerate its own vault, and both
collect scripts cap a note at four asset keys. A launch note is accepted only from
the faucet's owner, and only before the supply is minted.

Pricing belongs to the account, not the note. `noteScript(kind)` deserialises the
compiled package from `src/generated/contracts.ts` once and caches it;
`POOL_NOTE_KINDS` is the four a pool admits, `NOTE_KINDS` adds `register`,
`registry-collect`, `registry-config`, and `launch`.

### Transaction request (`notes/request.ts`)

| Variant | Use |
| --- | --- |
| `ownOutputNotesRequest(client, notes, target)` | A wallet signs. Declares the multisig three-word auth-args preimage, because the wallet account is private and cannot be built by `feeAwareTransactionRequestBuilder` |
| `outputNotesRequest(client, notes, target)` | The client's own key signs. Declares neither auth args nor block numbers; the client attaches its signature and the conversion info it fetched |

Both declare the target as a foreign account, because the kernel calls
`estimate_note_fee` on it to price the emitted note.

### Pool reads (`pool/reads.ts`, `pool/decoding.ts`, `pool/discovery.ts`)

| Export | Result |
| --- | --- |
| `fetchPoolState(getAccount, poolId)` | `PoolState` from the account |
| `decodePoolState(account)` | The same, from an `Account` already in hand |
| `decodeFeesWord`, `decodeAccountIdWord`, `decodeScalarWord`, `decodeReservesWord`, `decodeProtocolPotWord`, `decodeU128Word`, `assetKeyToFaucetIdFelts`, `isZeroWord4` | Single-word decoders |
| `xykNoteScriptRoots()`, `isXykPool(account)` | Identify a pool locally: a network account whose allowlist holds every XYK note root |
| `PoolRegistry` | Local pool map |

`PoolState` is `{ accountId, token0Key, token1Key, token0FaucetId, token1FaucetId,
reserve0, reserve1, lpSupply, fees, protocolPot, price0CumulativeLast,
price1CumulativeLast, blockTimestampLast, registryId, vaultAssetKeys }`. Reserves
are the contract's stored accounting; a credit the contract did not create is never
a reserve.

### Pool registry (`pool/registry.ts`)

| Export | Result |
| --- | --- |
| `createRegistryAccount(client, params)` | Builds the registry and inserts it into the store |
| `deployRegistryAccount(client, registryId, fundingNoteId, options?)` | Consumes the funding note as its first transaction |
| `registerPool(client, config, params, options?)` | `{ request, note, sponsorNote, fee }` for a register note |
| `readRegistryPools`, `readRegistryPoolForAssets`, `readRegistryAcceptedCodeCommitments`, `readRegistryFeePolicy`, `readRegistryRegisterFee`, `readRegistryAdmin` | Reads, each taking `(getAccount, registryId)` |
| `parseAccountId(value)` | Hex or bech32 to `AccountId` |
| `REGISTRY_SLOTS` | Slot names |

`CreateRegistryAccountParams` is `{ acceptedPoolCodeCommitment, feeFaucetId,
registerFee, protocolFeeTo, protocolFeeShareBps, allowedLpFeeBps, p2idRoot, admin,
authRoots, seed? }`. The registry admits three note kinds:

| Admitted kind | Price |
| --- | --- |
| `register` | `registerFee`, defaulting to `NOTE_FEES.register` when zero |
| `registry-collect` | `NOTE_FEES['registry-collect']` |
| `registry-config` | `0`, paid by the registry from the register fees it holds |

Every admitted root must carry a price: a root the fee policy does not price aborts
fee estimation, so the node's builder never executes that note and the account's
auth rejects it as an input. The allowlist is initial storage and its mutators are
gated on an authority this account does not install, so changing the admitted kinds
means deploying a new registry.

One account read returns at most 1000 map entries. Above that the map must be paged
with `SyncAccountStorageMaps`; `readRegistryPools` throws `INVARIANT` rather than
return a partial list.

### Pool creation (`pool/create.ts`, `pool/slots.ts`)

| Export | Result |
| --- | --- |
| `createPoolAccount(client, params)` | Builds the pool and inserts it into the store |
| `buildPoolAccount(client, params)` | The same, without inserting |
| `poolCodeCommitment(client, params)` | The code commitment the registry must accept |
| `poolAuthRoots(client, params)` | The six storage roots a registry pins |
| `deployPoolAccount(client, poolId, fundingNoteId, options?)` | Consumes the funding note as its first transaction |
| `createFeeFaucet(client, params)` | A public fungible faucet |
| `poolInitSlots(params)` | The eleven initial storage slots |

`CreatePoolAccountParams` is `{ token0Key, token1Key, token0Symbol, token1Symbol,
registryId, lpFeeBps, protocolFeeShareBps, p2idRoot?, feeFaucetId, noteFees?,
seed? }`. The two symbols name the LP token.

The pool account carries the `port0` component, the standard basic fungible faucet
component (the LP token's name and symbol), `CodeInspection` (the commitment the
registry reads), and the network auth. It is its own LP faucet: the contract
derives the LP asset id from the pool's account id.

#### LP token metadata

| Field | Value |
| --- | --- |
| Symbol | `PO` plus up to five A–Z letters of each side, e.g. `POUSDCXAAA` |
| Name | `port0 LP <token0>/<token1>` |
| Decimals | `0`; the app shows LP amounts in raw units |
| Max supply | `2^63 - 2^31`, the protocol's maximum fungible amount |

`TokenSymbol` allows uppercase ASCII letters only, 1 to 12 characters, so a digit
prefix such as `P0` is not representable. The metadata is fixed when the pool
account is built. `standardFaucetComponent` and `fungibleFaucetSlots` expose the
same component and layout for arbitrary metadata.

### Network faucet (`pool/networkFaucet.ts`)

| Export | Result |
| --- | --- |
| `createNetworkFaucet(client, params)` | Builds a fixed-supply faucet and inserts it |
| `buildNetworkFaucet(client, params)` | The same, without inserting |
| `deployNetworkFaucet(client, faucetId, fundingNoteId, options?)` | Consumes the funding note as its first transaction |
| `LAUNCH_FEE` | `119n`, the launch note price |

`CreateNetworkFaucetParams` is `{ name, symbol, decimals, maxSupply, owner,
feeFaucetId, seed? }`. A network account is exempt from a keyed-account allowlist,
so launching a token needs no invitation code. A launch mints the whole supply once
to the owner and records it; nothing can be minted afterwards.

### Pool config (`pool/config.ts`)

`PoolConfig` is `{ poolId, feeFaucetId, noteFees? }`; `noteFee(schedule, kind)`
resolves one price with `NOTE_FEES` as the fallback. `DEFAULT_DEADLINE_MARGIN_SECONDS`
is one hour.

### Operations (`ops/operations.ts`, `ops/helpers.ts`)

| Operation | Params |
| --- | --- |
| `swap(client, config, params, options?)` | `{ sender, recipient, tokenIn, amountIn, slippageBps, deadline }` |
| `addLiquidity` | `{ sender, recipient, amount0, amount1, slippageBps, deadline }` |
| `removeLiquidity` | `{ sender, recipient, amountLp, slippageBps, deadline }` |
| `collectFees` | `{ sender, assetKeys? }`, defaulting to every fungible asset in the vault |
| `registerPool` | `{ sender, poolId, asset0, asset1 }` |

Each runs the local quote, applies the slippage bound, builds the feature note and
its sponsorship, and returns `{ note, sponsorNote, request, fee, feeFaucetId }`.
`SubmitOptions` is `{ submit?, waitForConfirmation? }`: with `submit` the client
sends the request, otherwise the caller hands it to a wallet. `applySlippage`,
`resolveSwapSide`, and `deadlineFrom` are the helpers.

### Facade (`client.ts`)

`XykClient.from(client)` wraps a `MidenClient`; `xyk.pool(config)` returns a `Pool`
whose methods are the operations above with the pool's config applied.
`xyk.createPoolAccount`, `buildPoolAccount`, `poolCodeCommitment`, `poolAuthRoots`,
`deployPoolAccount`, `createRegistryAccount`, `deployRegistryAccount`,
`createFeeFaucet`, and `createNetworkFaucet` forward to the module functions.

### Artifacts and WASM

`contractPackageBytes(kind)` returns the compiled `.masp` bytes; `CONTRACT_KINDS`
lists them; `wasmModule()` returns the full web-sdk module on both platforms. The
generated artifacts live in `src/generated/contracts.ts`, and the collect holds in
`src/generated/fees.ts`.

## Layout

```
src/
  constants.ts          slot names, amount bounds, note prices
  client.ts             XykClient and Pool facade
  artifacts.ts          compiled package bytes
  wasm.ts               runtime access to the web-sdk module
  errors.ts             XykError with a stable code
  math/                 quotes, encoders
  notes/                storage layouts, builders, request variants, scripts
  ops/                  swap, add, remove, collect, register
  pool/                 create, reads, decoding, registry, faucets, discovery
  generated/            contract artifacts and fee constants
scripts/                deploy, set fee, collect, commitment
test/                   vitest suites and the WASM smoke test
```

## Regenerating artifacts

```sh
npm run generate
```

This builds every contract with `cargo miden` and exports the packages into
`src/generated`. A note that links an account interface embeds that account's
procedure roots, so an artifact exported before an interface change calls a root
the account no longer has. Building first is not optional. The contracts repo is
expected at `../port0_contracts`, overridable with `PORT0_CONTRACTS_DIR`.

## Build and test

```sh
npm run typecheck
npm test            # vitest: layouts, quotes, constants, faucet metadata
npm run test:wasm   # builds, then runs the WASM smoke test under Node
npm run build       # tsup: ESM, CJS, and types into dist/
```

`pool:commitment`, `registry:deploy`, `registry:set-fee`, and `fees:collect` run the
tooling in `scripts/`. They read the variables documented in `.env.example`.

## Source

Radicle is canonical; GitHub is a mirror.

| Source | Location |
| --- | --- |
| Radicle | https://radicle.network/nodes/iris.radicle.network/rad%3Az3fi1mouSisLs3PhaLxJiUZwhZnLd |
| GitHub | https://github.com/port0-sh/port0_sdk |
