#!/usr/bin/env node
/**
 * Creates and deploys the pool registry network account on a live network.
 *
 * The registry is built by the SDK's own `createRegistryAccount`, so the
 * deployed account's component set matches what the registration path expects.
 * The account is a network account: its first transaction must consume a
 * funding note, so this script funds it from an operator wallet and then
 * consumes that note.
 *
 * Interactive by default. If the operator wallet is missing or underfunded,
 * the script prints its address and polls until the fee asset arrives, then
 * funds and deploys the registry without a re-run. The wait is bounded by
 * `MIDEN_XYK_WAIT_SECS` (default 600); on timeout it prints the address and
 * exits. The Node client keeps its store and keys under
 * `~/.miden/stores/<MIDEN_XYK_STORE>/`, so a re-run resumes from that state,
 * and an already-deployed registry is reported and left alone.
 *
 * Environment (from the environment or a `.env` file in the current directory):
 *   MIDEN_XYK_FEE_FAUCET_ID   required, chain fee faucet
 *   MIDEN_XYK_POOL_COMMITMENT required, from `npm run pool:commitment`
 *   MIDEN_RPC_URL             default https://rpc.testnet.miden.io
 *   MIDEN_XYK_REGISTER_FEE    default 0, register note fee in base units
 *   MIDEN_XYK_FUND            default 1000, base units sent to the registry
 *   MIDEN_XYK_STORE           default miden-xyk-registry
 *   MIDEN_XYK_OPERATOR        optional, existing operator account id
 *   MIDEN_XYK_PROVER          default testnet
 *   MIDEN_XYK_NOTE_TRANSPORT  default testnet, for private notes
 *   MIDEN_XYK_WAIT_SECS       default 600, funding wait timeout
 *
 * Run: npm run build && node scripts/deploy-registry.mjs
 */
import { existsSync } from "node:fs";
import {
  AccountId,
  AccountInterface,
  MidenClient,
  NetworkId,
} from "@miden-sdk/miden-sdk";
import {
  createRegistryAccount,
  deployRegistryAccount,
  noteScript,
  p2idRoot,
  readRegistryAcceptedCodeCommitments,
  wasmModule,
} from "../dist/index.js";

/** Measured per-transaction verification fee, in the chain fee asset. */
const OPERATOR_TX_FEE = 133n;
/** Poll interval for the funding wait. */
const POLL_MS = 5_000;

async function main() {
  // Load `.env` from the current directory when present. Real environment
  // variables take precedence; a missing file is not an error.
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const feeFaucetId = required("MIDEN_XYK_FEE_FAUCET_ID");
  const poolCommitment = required("MIDEN_XYK_POOL_COMMITMENT");
  const rpcUrl = process.env.MIDEN_RPC_URL ?? "https://rpc.testnet.miden.io";
  const registerFee = BigInt(process.env.MIDEN_XYK_REGISTER_FEE ?? "133");
  const protocolFeeTo = required("MIDEN_XYK_PROTOCOL_FEE_TO");
  const protocolFeeShareBps = BigInt(process.env.MIDEN_XYK_PROTOCOL_FEE_SHARE_BPS ?? "1200");
  const allowedLpFeeBps = (process.env.MIDEN_XYK_LP_FEE_TIERS ?? "5,30,100")
    .split(",")
    .map((value) => BigInt(value.trim()));
  // The registry pays its accumulated fees with the standard P2ID note this
  // SDK ships with. A different root would need a matching consumer.
  const registryP2idRoot = p2idRoot();
  const fundAmount = BigInt(process.env.MIDEN_XYK_FUND ?? "1000");
  const storeName = process.env.MIDEN_XYK_STORE ?? "miden-xyk-registry";
  const operatorRef = process.env.MIDEN_XYK_OPERATOR;
  const proverUrl = process.env.MIDEN_XYK_PROVER ?? "testnet";
  const noteTransportUrl =
    process.env.MIDEN_XYK_NOTE_TRANSPORT ?? "testnet";
  const waitSecs = Number(process.env.MIDEN_XYK_WAIT_SECS ?? "600");

  const client = await MidenClient.create({
    rpcUrl,
    feeFaucetId,
    proverUrl,
    noteTransportUrl,
    autoSync: true,
    storeName,
  });

  const feeFaucet = AccountId.fromHex(feeFaucetId);
  const accounts = await allAccounts(client);
  const operator = await resolveOperator(client, accounts);
  const registry = await resolveRegistry(client, accounts, operator, {
    poolCommitment,
    feeFaucetId,
    registerFee,
    protocolFeeTo,
    protocolFeeShareBps,
    allowedLpFeeBps,
    registryP2idRoot,
  });

  if (!registry.isNew()) {
    console.log(`registry already deployed: ${registry.id().toString()}`);
    return;
  }

  // The operator pays the funding transaction and sends the registry its
  // starting balance. Proceed with whatever the operator holds above the
  // transaction fee, capped at the requested fund amount.
  const minimumBalance = OPERATOR_TX_FEE + 1n;
  let balance = await operatorBalance(client, operator.id(), feeFaucet);
  if (balance < minimumBalance) {
    console.log("operator wallet");
    console.log(`  address: ${addressOf(operator)}`);
    console.log(
      `  send fee asset: ${OPERATOR_TX_FEE + fundAmount} base units ` +
        `(${OPERATOR_TX_FEE} for the funding transaction, then ${fundAmount} to the registry, ` +
        "which pays its own first transaction from it)",
    );
    balance = await waitForBalance(
      client,
      operator.id(),
      feeFaucet,
      minimumBalance,
      waitSecs,
    );
  }
  const spendable = balance - OPERATOR_TX_FEE;
  const actualFund = fundAmount < spendable ? fundAmount : spendable;
  console.log(`operator balance: ${balance} base units`);

  console.log(`registry account: ${registry.id().toString()}`);
  console.log(`funding ${actualFund} base units`);
  await client.transactions.send({
    account: operator.id().toString(),
    to: registry.id().toString(),
    token: feeFaucetId,
    amount: actualFund,
    type: "public",
    waitForConfirmation: true,
  });

  await syncWithRetry(client);
  const consumable = await client.notes.listAvailable({
    account: registry.id().toString(),
  });
  if (consumable.length === 0) {
    throw new Error("funding note not visible yet; sync and re-run");
  }

  const { txId } = await deployRegistryAccount(
    client,
    registry.id(),
    consumable[0].id().toString(),
    { waitForConfirmation: true },
  );
  console.log(`deployed in ${txId.toHex()}`);
  console.log(`registry: ${registry.id().toString()}`);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function addressOf(account) {
  return account
    .id()
    .toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
}

/** Loads every tracked account as a full account. */
async function allAccounts(client) {
  const headers = await client.accounts.list();
  const loaded = [];
  for (const header of headers) {
    const account = await client.accounts.get(header.id());
    if (account) loaded.push(account);
  }
  return loaded;
}

/** Resolves the operator wallet, creating one on first run. */
async function resolveOperator(client, accounts) {
  const operatorRef = process.env.MIDEN_XYK_OPERATOR;
  if (operatorRef) {
    const account = await client.accounts.get(operatorRef);
    if (!account) {
      throw new Error(
        `operator ${operatorRef} is not in this store (${process.env.MIDEN_XYK_STORE ?? "default"}).\n` +
          "The operator pays for the deployment, so this script has to sign a transaction as it: " +
          "the account must be one whose keys this store holds. A wallet extension's account is " +
          "private and cannot be driven from here.\n" +
          "Leave MIDEN_XYK_OPERATOR unset to have the script create and use a local operator, then " +
          "fund the address it prints. The protocol fee recipient is only a payout address, so " +
          "MIDEN_XYK_PROTOCOL_FEE_TO may be any account, including your wallet.",
      );
    }
    return account;
  }
  const existing = accounts.find((account) => !account.isNetworkAccount());
  if (existing) return existing;

  const created = await client.accounts.create({ storage: "public" });
  console.log("created operator wallet");
  return created;
}

/**
 * Reuses a stored registry only when it admits both registry notes and accepts
 * the configured pool code.
 *
 * A registry is immutable, so an account that accepts a different commitment,
 * or that was built before the registry-collect entry was added to its note
 * allowlist, can never serve this deployment. One rejects every new pool, the
 * other leaves its register fees uncollectable, and both would be reused
 * silently by a check that looked at the accepted code alone. A non-matching
 * account is reported and a fresh registry is deployed instead.
 */
async function resolveRegistry(client, accounts, operator, config) {
  const candidates = accounts.filter(
    (account) =>
      account.isNetworkAccount() &&
      account.id().toString() !== operator.id().toString(),
  );

  const expected = wasmModule()
    .Word.fromHex(config.poolCommitment)
    .toU64s()
    .map((limb) => BigInt(limb));
  const accepts = (accepted) =>
    accepted.some(
      (word) =>
        word.length === expected.length &&
        word.every((limb, index) => BigInt(limb) === expected[index]),
    );

  // A root the fee policy does not price aborts fee estimation, so the registry
  // can never consume that note: the account's own auth rejects it as an input.
  const collectRoot = noteScript("registry-collect").root().toHex();

  for (const candidate of candidates) {
    const admitted = new Set(
      (candidate.networkNoteAllowlist() ?? []).map((root) => root.toHex()),
    );
    if (!admitted.has(collectRoot)) {
      console.log(
        `stored registry ${candidate.id().toString()} does not admit the registry-collect ` +
          `note (${admitted.size} note root(s) allowlisted); deploying a new registry`,
      );
      continue;
    }

    const accepted = await readRegistryAcceptedCodeCommitments(
      (id) => client.accounts.get(id),
      candidate.id(),
    );
    if (accepts(accepted)) return candidate;
    console.log(
      `stored registry ${candidate.id().toString()} does not accept this pool code ` +
        `(${accepted.length} accepted, none equal to ${config.poolCommitment}); ` +
        "deploying a new registry",
    );
  }

  return createRegistryAccount(client, {
    acceptedPoolCodeCommitment: config.poolCommitment,
    feeFaucetId: config.feeFaucetId,
    registerFee: config.registerFee,
    protocolFeeTo: config.protocolFeeTo,
    protocolFeeShareBps: config.protocolFeeShareBps,
    allowedLpFeeBps: config.allowedLpFeeBps,
    p2idRoot: config.registryP2idRoot,
  });
}

/**
 * Reads the operator's balance of the fee asset after a sync.
 *
 * A received note sits in the input-note set until it is consumed; the vault
 * reflects it only after consumption. This consumes every note the operator
 * can consume before reading the balance, so a plain transfer is enough to
 * fund the operator.
 */
async function operatorBalance(client, accountId, feeFaucet) {
  await syncWithRetry(client);

  const available = await client.notes.listAvailable({
    account: accountId.toString(),
  });
  if (available.length > 0) {
    const result = await client.transactions.consumeAll({
      account: accountId.toString(),
      waitForConfirmation: true,
    });
    console.log(`  consumed ${result.consumed} incoming note(s)`);
    await syncWithRetry(client);
  }

  const account = await client.accounts.get(accountId);
  return account ? account.vault().getBalance(feeFaucet) : 0n;
}

/**
 * Syncs the chain, re-fetching when a concurrent sync advanced the store
 * between the fetch and its apply.
 *
 * `waitForConfirmation` polls with its own syncs, so a sync issued right after
 * one can be applied against a store that moved. The client reports that as
 * `chain sync chain_sync_data starts at block X but the client is at block Y`
 * and the fetched data is stale by definition; re-fetching from the current tip
 * is the fix, not a retry against unchanged state.
 */
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

/** Polls until the operator holds `required` base units, or times out. */
async function waitForBalance(client, accountId, feeFaucet, required, waitSecs) {
  const deadline = Date.now() + waitSecs * 1000;
  let lastLogged = -1n;
  for (;;) {
    const balance = await operatorBalance(client, accountId, feeFaucet);
    if (balance >= required) return balance;
    if (balance !== lastLogged) {
      console.log(`  balance: ${balance}/${required} base units, waiting`);
      lastLogged = balance;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `funding not received within ${waitSecs}s ` +
          `(balance ${balance}/${required}); send the fee asset and run again`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
