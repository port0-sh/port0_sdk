#!/usr/bin/env node
/**
 * Sweeps protocol fees to the fee recipient.
 *
 *   node scripts/collect-fees.mjs registry [--submit]
 *   node scripts/collect-fees.mjs pool <pool-id> [--submit]
 *
 * Dry run by default: it reports what is claimable, where it would go, and what
 * the sweep costs the caller, and submits nothing. `--submit` performs it.
 *
 * Two pots, two notes:
 *
 * - The registry holds the register fees it charged, in the chain fee asset, and
 *   pays them out when a `registry-collect` note targeting it is consumed.
 * - A pool holds the protocol's share of its LP fees, in its own two tokens, and
 *   pays them to the destination the registry names, read over FPI when its
 *   `collect` note is consumed.
 *
 * Both are permissionless. The script emits each collect note together with a
 * FEE_SPONSORSHIP note for it, the way this SDK submits every other feature
 * note, and lets the network transaction builder consume the pair. If that has
 * not happened by the end of the wait window, it builds, executes, and submits
 * that same transaction itself, since a network account's auth admits any
 * transaction whose consumed note script roots are allowlisted.
 *
 * The sponsorship is required, not a convenience. A collect note sweeps the
 * whole balance of the asset it pays out, and the registry's balance is held in
 * the fee asset, so the account's own vault is empty by the time the
 * transaction fee is settled and the transaction aborts with "failed to remove
 * the fungible asset from the vault". The sponsorship carries the fee instead.
 * The caller pays it, `TX_FEE` base units, on top of its own transaction fee.
 *
 * Buying the fee asset is not required. A few hundred base units in the store's
 * account covers many sweeps at the measured 133 per transaction.
 *
 * Environment (from the environment or a `.env` file in this directory):
 *   PORT0_REGISTRY_ID     required for the registry target
 *   PORT0_FEE_FAUCET_ID   required, chain fee faucet
 *   MIDEN_RPC_URL         default https://rpc.testnet.miden.io
 *   PORT0_PROVER          default testnet
 *   PORT0_STORE           default port0-registry, must hold the caller's key
 *   PORT0_OPERATOR        optional, caller account id; defaults to the first
 *                         non-network account in the store
 */
import { existsSync } from "node:fs";
import {
  AccountId,
  AccountInterface,
  BasicFungibleFaucetComponent,
  MidenClient,
  NetworkId,
  NoteAndArgs,
  NoteAndArgsArray,
  TransactionRequestBuilder,
} from "@miden-sdk/miden-sdk";
import { buildFeeSponsorshipNote } from "@port0.sh/sdk";
import {
  buildCollectNote,
  buildRegistryCollectNote,
  decodePoolState,
  fungibleAssetIdWord,
  outputNotesRequest,
  readRegistryFeePolicy,
} from "../dist/index.js";

/**
 * Funding floor for the caller, in the fee asset's base units: the largest
 * transaction fee measured on testnet (133). The fee is charged by the network
 * and varies between transactions, so a sweep that costs more fails loudly and
 * the figure is updated from the measurement the sweep prints.
 */
const TX_FEE = 133n;
/**
 * Transaction fee measured on the emitting transaction, in base units: the
 * difference the caller's balance showed across the registry sweep's emit.
 */
const EMIT_FEE = 119n;
/**
 * Every note kind a pool allowlists is priced at the measured transaction fee
 * when the pool is created, which is also the amount its collect note must be
 * sponsored with. A registry prices `registry-collect` at zero.
 */
const POOL_COLLECT_FEE = 133n;
/** Fee asset a registry sweep needs: sponsorship, no note fee, emit fee. */
const REGISTRY_SWEEP_COST = TX_FEE + EMIT_FEE;
/** Fee asset a pool sweep needs: sponsorship, the pool's note fee, emit fee. */
const POOL_SWEEP_COST = TX_FEE + POOL_COLLECT_FEE + EMIT_FEE;
/**
 * The caller pays its own transaction fee when it claims an incoming funding
 * note, so a note of `N` adds `N - EMIT_FEE` to the vault. Funding requests add
 * this so that one send covers the shortfall.
 */
const CLAIM_FEE = EMIT_FEE;
/** Poll interval while waiting for the caller to be funded. */
const POLL_MS = 5_000;
/** How long to wait for funding before giving up. */
const WAIT_SECS = Number(process.env.PORT0_WAIT_SECS ?? "600");
/** Poll interval while waiting for a network account to consume a collect note. */
const PAYOUT_POLL_MS = 5_000;
/**
 * How long to wait for that consumption before acting directly, in seconds. The
 * one register note this registry consumed landed two blocks after it was
 * emitted, about twenty seconds, so ninety covers the observed behaviour.
 */
const PAYOUT_WAIT_SECS = Number(process.env.PORT0_PAYOUT_WAIT_SECS ?? "90");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** `0x` plus the id's hex, whatever form the caller passed. */
function asHex(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function main() {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const target = process.argv[2];
  const submit = process.argv.includes("--submit");

  if (target !== "registry" && target !== "pool") {
    throw new Error(
      "usage: node scripts/collect-fees.mjs registry [--submit]\n" +
        "       node scripts/collect-fees.mjs pool <pool-id> [--submit]",
    );
  }

  const feeFaucetId = AccountId.fromHex(required("PORT0_FEE_FAUCET_ID"));
  const rpcUrl = process.env.MIDEN_RPC_URL ?? "https://rpc.testnet.miden.io";
  const proverUrl = process.env.PORT0_PROVER ?? "testnet";
  const storeName = process.env.PORT0_STORE ?? "port0-registry";

  const client = await MidenClient.create({
    rpcUrl,
    feeFaucetId: feeFaucetId.toString(),
    proverUrl,
    noteTransportUrl: "testnet",
    autoSync: true,
    storeName,
  });

  const caller = await resolveCaller(client);
  const registryId = AccountId.fromHex(required("PORT0_REGISTRY_ID"));
  const policy = await readRegistryFeePolicy(
    (id) => client.accounts.get(id),
    registryId,
  );

  console.log(`caller (this store): ${caller.id().toString()}`);
  console.log(`destination (from the registry): ${policy.protocolFeeTo.toString()}`);
  console.log("cost: the caller's own transaction fee, charged in the fee asset");

  if (target === "registry") {
    await sweepRegistry(client, caller, registryId, feeFaucetId, submit);
  } else {
    const poolArg = process.argv[3];
    if (!poolArg || poolArg.startsWith("--")) {
      throw new Error("the pool target needs a pool account id");
    }
    await sweepPool(client, caller, AccountId.fromHex(asHex(poolArg)), feeFaucetId, submit);
  }
}

/** The account that pays for emitting the note. */
async function resolveCaller(client) {
  const ref = process.env.PORT0_OPERATOR;
  if (ref) {
    const account = await client.accounts.get(ref);
    if (!account) {
      throw new Error(
        `PORT0_OPERATOR ${ref} is not in this store (${process.env.PORT0_STORE ?? "port0-registry"}).\n` +
          "The caller signs the transaction, so its key has to be in the store. " +
          "Leave PORT0_OPERATOR unset to use the first non-network account.",
      );
    }
    return account;
  }
  const headers = await client.accounts.list();
  for (const header of headers) {
    const account = await client.accounts.get(header.id());
    if (account && !account.isNetworkAccount()) return account;
  }
  throw new Error(
    "no account in this store can pay for the sweep. Create or fund one, then " +
      "set PORT0_OPERATOR to it.",
  );
}

/** The registry's vault balance of the fee asset, in base units. */

/** The caller's own fee-asset balance, for measuring what a transaction cost. */
async function callerHeld(client, callerId, feeFaucetId) {
  await syncWithRetry(client);
  const account = await client.accounts.get(callerId.toString());
  return account ? account.vault().getBalance(feeFaucetId) : 0n;
}

async function registryHeld(client, registryId, feeFaucetId) {
  await syncWithRetry(client);
  const account = await client.accounts.get(registryId.toString());
  const held = account ? account.vault().getBalance(feeFaucetId) : 0n;
  return held;
}

/**
 * Waits for a network account to consume the collect note.
 *
 * The caller's transaction only emits the note. A network account is executed by
 * the node's network transaction builder, which consumes the note in a later
 * block, so the payout lands after the transaction that asked for it. Returns
 * the new reading, or null when the window closes with the note still unclaimed.
 */
async function waitForPayout(read, before, describe) {
  const deadline = Date.now() + PAYOUT_WAIT_SECS * 1_000;
  let lastLogged = 0;
  for (;;) {
    const now = await read();
    if (now !== before) return now;
    if (Date.now() >= deadline) return null;
    const waited = Math.round((PAYOUT_WAIT_SECS * 1_000 - (deadline - Date.now())) / 1_000);
    if (waited - lastLogged >= 30) {
      console.log(`  ${describe} still ${before}; waiting for the network builder to consume the note`);
      lastLogged = waited;
    }
    await new Promise((resolve) => setTimeout(resolve, PAYOUT_POLL_MS));
  }
}


/** The caller's address, in the form a wallet sends to. */
function addressOf(account) {
  return account
    .id()
    .toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
}

/** Syncs, re-fetching when a concurrent sync moved the store in between. */
async function syncWithRetry(client, attempts = 4) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.syncChain();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stale = message.includes("chain sync chain_sync_data starts at block");
      if (!stale || attempt + 1 >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * The caller's fee-asset balance after consuming what it can consume.
 *
 * A received note sits in the input-note set until it is consumed, and the vault
 * only reflects it afterwards, so a plain transfer is not enough on its own.
 */
async function callerBalance(client, callerId, feeFaucetId, consume) {
  await syncWithRetry(client);
  const available = await client.notes.listAvailable({
    account: callerId.toString(),
  });
  if (available.length > 0 && consume) {
    const result = await client.transactions.consumeAll({
      account: callerId.toString(),
      waitForConfirmation: true,
    });
    console.log(
      `  consumed ${result.consumed} incoming note(s); the caller pays a transaction fee for each`,
    );
    await syncWithRetry(client);
  }
  const account = await client.accounts.get(callerId.toString());
  return {
    held: account ? account.vault().getBalance(feeFaucetId) : 0n,
    incoming: available.length,
  };
}

/**
 * Reports what the caller holds, and waits for it when a sweep is requested.
 *
 * A dry run never waits: it states the shortfall and the address to send to, so
 * funding is a decision rather than a surprise.
 */
async function callerFunding(client, caller, feeFaucetId, submit, required) {
  // Only a submitting run consumes: consuming is a transaction, and a dry run
  // must not spend anything.
  const { held, incoming } = await callerBalance(client, caller.id(), feeFaucetId, submit);
  const balance = held;
  if (incoming > 0) {
    console.log(
      `caller has ${incoming} incoming note(s) not yet consumed` +
        (submit ? "" : "; the sweep will consume them"),
    );
  }
  const feeMeta = await readFaucetMeta(client, feeFaucetId);

  if (balance >= required) {
    console.log(`caller holds ${money(balance, feeMeta)}, covering the ${money(required, feeMeta)} needed`);
    return;
  }

  const shortfall = required - balance;
  console.log(`caller holds ${money(balance, feeMeta)}, and the sweep needs ${money(required, feeMeta)}`);
  console.log("send the fee asset to the caller:");
  console.log(`  address: ${addressOf(caller)}`);
  console.log(
    `  amount:  at least ${money(shortfall + CLAIM_FEE, feeMeta)}, more for further sweeps`,
  );
  console.log(
    `  note:    claiming an incoming note is a transaction the caller pays for, ` +
      `about ${money(CLAIM_FEE, feeMeta)}, so a note of that size nets the shortfall`,
  );

  if (!submit) return;

  const deadline = Date.now() + WAIT_SECS * 1_000;
  let logged = balance;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const { held: current } = await callerBalance(client, caller.id(), feeFaucetId, true);
    if (current >= required) {
      console.log(`funded: ${money(current, feeMeta)}; continuing`);
      return;
    }
    if (current !== logged) {
      console.log(
        `  balance: ${money(current, feeMeta)} of ${money(required, feeMeta)} needed, waiting`,
      );
      logged = current;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the caller is still short after ${WAIT_SECS}s (${money(current, feeMeta)} of ` +
          `${money(required, feeMeta)}). ` +
          `Send the fee asset to ${addressOf(caller)} and run again.`,
      );
    }
  }
}



/** Faucet symbol and decimals, keyed by faucet id, read from the chain once. */
const faucetMeta = new Map();

/**
 * Reads a faucet's symbol and decimals, the scale every amount is printed at.
 * Returns undefined when the account is not a plain fungible faucet or the read
 * fails, in which case amounts are printed in base units alone.
 */
async function readFaucetMeta(client, faucetId) {
  const key = faucetId.toString();
  if (faucetMeta.has(key)) return faucetMeta.get(key);
  let meta;
  try {
    // The faucet is usually not in this store yet, and reading its metadata
    // needs the account, so import it the way any public account is read.
    const account = await client.accounts.getOrImport(key);
    const faucet = BasicFungibleFaucetComponent.fromAccount(account);
    meta = {
      symbol: faucet.symbol().toString(),
      decimals: Number(faucet.decimals()),
    };
  } catch {
    meta = undefined;
  }
  if (!meta) {
    await syncWithRetry(client).catch(() => {});
    try {
      const account = await client.accounts.getOrImport(key);
      const faucet = BasicFungibleFaucetComponent.fromAccount(account);
      meta = {
        symbol: faucet.symbol().toString(),
        decimals: Number(faucet.decimals()),
      };
    } catch {
      meta = undefined;
    }
  }
  faucetMeta.set(key, meta);
  return meta;
}

/** Prints an amount in units and base units, e.g. `0.000181 USDCX (181 base units)`. */
function money(value, meta) {
  const raw = `${value} base units`;
  if (!meta) return raw;
  const scale = 10n ** BigInt(meta.decimals);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(meta.decimals, "0")
    .replace(/0+$/, "");
  return `${fraction === "" ? whole : `${whole}.${fraction}`} ${meta.symbol} (${raw})`;
}

/** Prints the ids of the notes this account has emitted, newest first. */
async function printSentNoteIds(client, accountId) {
  try {
    const sent = await client.notes.listSent({ account: accountId.toString() });
    const records = Array.isArray(sent) ? sent : (sent?.notes?.() ?? []);
    if (records.length === 0) {
      console.log("  no emitted notes in the store yet");
      return;
    }
    for (const record of records.slice(-3).reverse()) {
      const id = typeof record.id === "function" ? record.id() : record.id;
      let state = "";
      try {
        state = ` state=${record.state()}`;
      } catch {
        // the record may not expose state in every client version
      }
      try {
        if (record.isConsumed()) state += " consumed";
      } catch {
        // likewise
      }
      console.log(`  note ${id}${state}`);
    }
  } catch (error) {
    console.log(`  note ids unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pairs a collect note with the sponsorship note that pays its transaction fee.
 *
 * The collect note sweeps the whole balance of the asset it pays out, and for a
 * registry that asset is the fee asset, so the vault is empty by the time the
 * transaction fee is settled and the transaction aborts. The sponsorship note
 * carries the fee itself and is consumed together with the collect note, which
 * is how this SDK submits every other feature note. Sponsoring costs the caller
 * `TX_FEE` and leaves the swept pot whole for the destination.
 */
function sponsorCollect(sender, target, featureNote, feeFaucetId) {
  return buildFeeSponsorshipNote({
    sender,
    target,
    featureNote,
    feeFaucetId,
    feeAmount: TX_FEE,
  });
}

/**
 * Consumes the collect note in a transaction built and submitted here.
 *
 * A network account's auth admits any transaction whose consumed note script
 * roots are allowlisted, and whose transaction script, if any, is allowlisted.
 * Nothing restricts who builds it, so the transaction the network builder would
 * build can be built here too. It is executed first, which submits nothing and
 * costs nothing, so a protocol rejection surfaces as the protocol's own error
 * instead of a transaction that quietly does nothing.
 */
async function payOutDirectly(client, accountId, notes, describe) {
  const request = new TransactionRequestBuilder()
    .withInputNotes(new NoteAndArgsArray(notes.map((n) => new NoteAndArgs(n))))
    .build();

  try {
    await client.transactions.executeRequest(accountId.toString(), request);
  } catch (error) {
    console.error(`the network account rejected the payout transaction:`);
    console.error(error instanceof Error ? error.message : String(error));
    throw error;
  }

  const { txId } = await client.transactions.submit(
    accountId.toString(),
    request,
  );
  console.log(`  ${describe}: submitting the payout directly (${txId.toHex()})`);
  await client.transactions.waitFor(txId, { timeout: 180_000 });
  return txId;
}

async function sweepRegistry(client, caller, registryId, feeFaucetId, submit) {
  await callerFunding(client, caller, feeFaucetId, submit, REGISTRY_SWEEP_COST);
  const before = await registryHeld(client, registryId, feeFaucetId);
  console.log(
    `registry ${registryId.toString()} holds ${money(before, await readFaucetMeta(client, feeFaucetId))}`,
  );
  if (before === 0n) {
    console.log("nothing to sweep: the registry holds no register fees.");
  }

  const note = buildRegistryCollectNote({
    sender: caller.id(),
    registryId,
    assetKey: fungibleAssetIdWord(feeFaucetId),
  });
  const sponsor = sponsorCollect(caller.id(), registryId, note, feeFaucetId);
  const request = await outputNotesRequest(client, [note, sponsor], registryId);

  if (!submit) {
    console.log("dry run: the note is built and nothing is submitted. Pass --submit to sweep.");
    return;
  }

  const paidBefore = await callerHeld(client, caller.id(), feeFaucetId);
  const { txId } = await client.transactions.submit(caller.id(), request);
  console.log(`submitted ${txId.toHex()}; waiting for confirmation`);
  await client.transactions.waitFor(txId);
  const paidAfter = await callerHeld(client, caller.id(), feeFaucetId);
  console.log(
    `caller paid ${money(paidBefore - paidAfter, await readFaucetMeta(client, feeFaucetId))} of its own fee asset`,
  );
  console.log("emitted notes:");
  await printSentNoteIds(client, caller.id());

  const after = await waitForPayout(
    () => registryHeld(client, registryId, feeFaucetId),
    before,
    "registry",
  );
  if (after === null) {
    console.log(
      `the network builder did not consume the note within ${PAYOUT_WAIT_SECS}s; ` +
        `acting directly`,
    );
    await payOutDirectly(client, registryId, [note, sponsor], "registry");
    const paid = await registryHeld(client, registryId, feeFaucetId);
    const paidMeta = await readFaucetMeta(client, feeFaucetId);
    console.log(
      `registry now holds ${money(paid, paidMeta)} (paid out ${money(before - paid, paidMeta)})`,
    );
    return;
  }
  const registryMeta = await readFaucetMeta(client, feeFaucetId);
  console.log(
    `registry now holds ${money(after, registryMeta)} (paid out ${money(before - after, registryMeta)})`,
  );
}

async function sweepPool(client, caller, poolId, feeFaucetId, submit) {
  await callerFunding(client, caller, feeFaucetId, submit, POOL_SWEEP_COST);
  const account = await client.accounts.getOrImport(poolId.toString());
  const state = decodePoolState(account);
  const pot = state.protocolPot;
  const meta0 = await readFaucetMeta(client, state.token0FaucetId);
  const meta1 = await readFaucetMeta(client, state.token1FaucetId);
  console.log(
    `pool ${poolId.toString()} holds ${money(pot.amount0, meta0)} and ${money(pot.amount1, meta1)} in its protocol pot`,
  );
  if (pot.amount0 === 0n && pot.amount1 === 0n) {
    console.log("nothing to sweep: the pool's protocol pot is empty.");
  }

  const note = buildCollectNote({ sender: caller.id(), poolId });
  const sponsor = sponsorCollect(caller.id(), poolId, note, feeFaucetId);
  const request = await outputNotesRequest(client, [note, sponsor], poolId);

  if (!submit) {
    console.log("dry run: the note is built and nothing is submitted. Pass --submit to sweep.");
    return;
  }

  const paidBefore = await callerHeld(client, caller.id(), feeFaucetId);
  const { txId } = await client.transactions.submit(caller.id(), request);
  console.log(`submitted ${txId.toHex()}; waiting for confirmation`);
  await client.transactions.waitFor(txId);
  const paidAfter = await callerHeld(client, caller.id(), feeFaucetId);
  console.log(`caller paid ${paidBefore - paidAfter} base units of its own fee asset`);
  console.log("emitted notes:");
  await printSentNoteIds(client, caller.id());

  const readPot = async () => {
    await syncWithRetry(client);
    const account = await client.accounts.get(poolId.toString());
    return account ? decodePoolState(account).protocolPot : { amount0: -1n, amount1: -1n };
  };
  const beforePot = `${pot.amount0}/${pot.amount1}`;
  const after = await waitForPayout(
    async () => {
      const now = await readPot();
      return `${now.amount0}/${now.amount1}`;
    },
    beforePot,
    "pool pot",
  );
  if (after === null) {
    console.log(
      `the network builder did not consume the note within ${PAYOUT_WAIT_SECS}s; ` +
        `acting directly`,
    );
    await payOutDirectly(client, poolId, [note, sponsor], "pool");
    const potNow = await readPot();
    console.log(
      `pool pot now holds ${money(potNow.amount0, meta0)} and ${money(potNow.amount1, meta1)}`,
    );
    return;
  }
  const potAfter = await readPot();
  console.log(
    `pool pot now holds ${money(potAfter.amount0, meta0)} and ${money(potAfter.amount1, meta1)}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
