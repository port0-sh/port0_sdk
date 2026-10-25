# Preflight

A one-off verification of the contracts, run once against testnet and once
against the partner mainnet. It looks for holes: a registry that admits the wrong
pool, a note priced wrong, a collect that moves more than the hold allows, a
lever anyone can pull.

It is not a recurring operational tool. It runs, it reports, it is done.

## 0. Status

| Run | Result |
| --- | --- |
| testnet, phases 0–7 | 44 checks, 0 failures, 8,518 base units, 206 s |
| mainnet, phases 0–6 | 40 checks, 0 failures, 6,168 base units, 191 s |
| mainnet, phases 0–7 | 44 checks, 0 failures, 6,399 base units, 272 s |

This document states what the runner does, not what it was meant to do.

## 1. Shape

Every run is self-contained. The only account that exists before it starts is the
operator; everything else is created by the run and left behind in a registry of
its own.

| Rule | Enforcement |
| --- | --- |
| A run MUST NOT write a production registry | the runner refuses a write phase whose `PORT0_REGISTRY_ID` equals the production id for the selected chain |
| A run MUST create its own registry, pool and faucet | all three are network accounts, created inside the run |
| The only pre-existing account is the operator | its key must be in the store; the runner drains its incoming notes, then prints the balance and refuses to spend more than it holds |
| Chains share nothing | `--chain` selects disjoint constants and stores |

Wallet accounts are out of scope. The operator is keyed and signs everything the
suite asks for.

## 2. Chains

Constants are baked into the runner; only the operator comes from the environment.

| | testnet | mainnet |
| --- | --- | --- |
| RPC | `https://rpc.testnet.miden.io` | `https://rpc.cedar.miden.io` |
| Fee faucet | `0x4cbdcaffe75f0a317482224dae6436` | `0xe69e6ca6e39df1b10c1e5399399feb` |
| Store | `port0-registry` | `port0-mainnet` |
| Production registry, read only | `0x8ca42fa29059dd1122da497505c681` | `0x219eab0784be9111213edf3324795f` |
| Invitation codes | not needed | one per keyed account phase 7 creates |

`npm run preflight` runs `npm run generate` first, so the packages compared
against the chain are built from the current contracts source. Phase 0 prints the
build timestamp and the pool and registry SHA-256s, and writes them into
`--report`, so a stale artifact cannot pass silently.

## 3. Phase 0 — deployed conformance, 0 base units

Reads each chain's production registry and never writes it.

| Step | Read | Compared with |
| --- | --- | --- |
| 0.0 | build provenance | `GENERATED_AT`, `CONTRACT_SHA256` for pool and registry |
| 0.1 | `accepted_code_commitments` | `poolCodeCommitment()` of this build |
| 0.2 | pinned `get_auth_identity` and `get_fee_identity` roots | `poolAuthRoots()` |
| 0.3 | pinned `p2id_root` | `p2idRoot()` |
| 0.4 | pinned `register_note_root` | `noteScript("register").root()` |
| 0.5 | admin, protocol recipient, share, tiers, register fee | recorded as observed values |
| 0.6 | one live pool's code commitment | the accepted commitment |
| 0.7 | that pool's registry pointer, fee tier, protocol share | the registry's policy |
| 0.8 | that pool's LP faucet | symbol shape `PO[A-Z]{1,10}`, decimals 0, max supply `2^63 − 2^31` |
| 0.9 | the chain's fee faucet | the configured value; its decimals are read here and used for every amount printed |
| 0.10 | the operator, and the node allowlist | the allowlist is **not queried**: the node gates account creation, and this operator already exists |
| 0.11 | the operator's balance | printed; spending phases refuse to start short |
| 0.12 | the indexer `/status`, then one pool's reserves | registry id, pool count, and that pool's reserves equal the chain read |

## 4. Phases that spend

The registry's admin is the operator, which is what makes the fee lever testable
without a wallet.

### Phase 1 — preflight registry, 1,119 base units

Creates the registry with this build's commitment and auth roots, funds it with
1,000, deploys it by consuming the funding note, then reads back the admin, the
accepted commitment and the register fee.

### Phase 2 — admin fee lever, 238 base units

Reads the live fee, has the operator (as admin) emit a registry-config note
raising it to 120, waits for the registry to consume it, then reverts to 119 and
reads it again. Any other sender cannot: that refusal is asserted by
`registry_rejects_a_foreign_fee_change` in the integration suite, and by phase 7
on a live chain when a tester code is supplied.

### Phase 3 — network faucet, 826 base units

Creates a network faucet owned by the operator, funds it with 112, deploys it,
launches it, consumes the payout note, and checks that the supply equals the
configured max supply and that a second launch mints nothing.

### Phase 4 — pool, registration and LP, 2,980 base units

Creates a pool of the launched token and the fee asset at 30 bps, funds and
deploys it, registers it at the **live** register fee, then checks the pair maps
to the pool, the pool's registry pointer, fee tier, protocol share and LP metadata
match, and deposits 500,000 / 2,000 for 31,622 LP against the locked minimum.

### Phase 5 — swap and guards, 371 base units

Emits a swap, then checks `k` did not decrease and the protocol pot grew. The
quoter refuses a pool with an empty side and a token the pool does not hold; the
contract's own slippage guard is covered by the integration suite.

### Phase 6 — fee sweeps and the LP exit, 634 base units

Runs `fees:collect registry` and `fees:collect pool` against the run's own
accounts, records the swept amount and the residue, then burns every LP the
operator holds and checks the pool keeps the locked minimum and non-zero reserves.

### Phase 7 — refused operations from a second account, 231 base units

Needs a keyed account that is not the operator: an invitation code registers one,
or `--tester <id>` reuses one already in the store. Without either the phase
reports that it did not run, and spends nothing. On mainnet each run needs a fresh
code, because a code binds to one account.

| Step | Attempt | Expected |
| --- | --- | --- |
| 7.1 | the tester emits a registry-config note raising the register fee | the fee is unchanged |
| 7.2 | the tester emits a launch note for a faucet owned by the operator | nothing is minted to the tester |

Because the tester is neither the operator nor the admin, 7.1 is the contract's
own access control being exercised against a real second keyed account rather
than asserted in a mock.

On testnet there is no gate, so the tester is created and funded by the operator
and 7.1 and 7.2 run without codes.

## 5. Budget, measured

| Phase | testnet | mainnet |
| --- | --- | --- |
| 0 | 0 | 0 |
| 1 | 1,119 | 1,119 |
| 2 | 238 | 238 |
| 3 | 826 | 826 |
| 4 | 2,980 | 2,980 |
| 5 | 371 | 371 |
| 6 | 634 | 634 |
| 7 | 231 | 231 |
| total | 6,399 | 6,399 |

The gross figure is what leaves the operator. A run returns the fee it paid into
its own registry (about 500 base units) when phase 6 sweeps it, so the net is
lower by that amount. The 1,000 base units funding the registry stay there, owned
by a registry the run created.

## 6. Runner

```sh
npm run preflight -- --chain mainnet --report preflight-mainnet.json          # phase 0 only
npm run preflight -- --chain mainnet --yes --report preflight-mainnet.json    # every phase
npm run preflight -- --chain mainnet --phase 0,7 --yes --code <code>          # one phase
```

| Behaviour | Detail |
| --- | --- |
| Writes | refused when the target registry equals the production id |
| Spending | any phase that spends needs `--yes` |
| Funding | incoming notes are drained first; a shortfall prints the operator's bech32 and hex address |
| Codes | `--code` may be repeated, or `--codes a,b`; an interactive run prompts for what it needs |
| Output | decimal and base units for every amount, one section per phase, transaction ids for each step |
| Report | `--report` writes every observed value, the provenance hashes, and the spend |

## 7. Not covered

| Gap | Why |
| --- | --- |
| Wallet auth: multisig requests, session restore, expired transactions | browser wallets are out of scope |
| Private notes over the note transport | would need a wallet recipient |
| Registering a pool built with a foreign fee rate, fee asset, payout script or allowlist | needs a deliberately mis-built pool, and each attempt leaves a prepaid sponsorship behind; the integration suite asserts all four |
| Any fungible faucet | there is no token allowlist to test: admission checks code, auth roots, fee asset, fee values and pair uniqueness, all asserted by the integration suite and proven on chain by phase 4 |
| A second pool for the same pair on a live registry | integration suite |
| Deadline expiry, two collects racing in one block | not modelled |
| Behaviour if the chain's base fee changes | would need a network fee change |
| The app's rendering and its cache | verified in a browser, separately |

## 8. Report

The runner writes, and the run records next to it:

| Field | Value |
| --- | --- |
| Date, chain, operator, balance before and after | |
| Build provenance: generated at, contract hashes | |
| Phase 0 comparisons, and any mismatch | |
| Preflight registry id, faucet id, pool id | |
| Fees before and after the lever | |
| Swept amounts and residues | |
| Phase 7 attempts and their outcome | |
