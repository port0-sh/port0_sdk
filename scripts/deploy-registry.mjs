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
 * `PORT0_WAIT_SECS` (default 600); on timeout it prints the address and
 * exits. The Node client keeps its store and keys under
 * `~/.miden/stores/<PORT0_STORE>/`, so a re-run resumes from that state,
 * and an already-deployed registry is reported and left alone.
 *
 * Every value that becomes registry policy or identifies an account is
 * **required**: none of them has a default, because a wrong value here is
 * permanent for that registry. Before spending anything the script prints them
 * and asks the deployer to confirm, either by typing `deploy` or by passing
 * `--yes` for an unattended run.
 *
 * Environment (from the environment or a `.env` file in the current directory):
 *   PORT0_FEE_FAUCET_ID         required, chain fee faucet
 *   PORT0_POOL_COMMITMENT       required, from `npm run pool:commitment`
 *   PORT0_OPERATOR              required, the keyed account that funds the registry
 *   PORT0_REGISTRY_ADMIN        required, the account allowed to change the register fee
 *   PORT0_REGISTER_FEE          required, register note price in base units
 *   PORT0_PROTOCOL_FEE_TO       required, account that receives every pool's protocol fees
 *   PORT0_PROTOCOL_FEE_SHARE_BPS required, protocol share of the LP fee, in bps
 *   PORT0_LP_FEE_TIERS          required, comma-separated LP fee tiers in bps
 *   PORT0_STORE                 required, client store holding the operator's key
 *   MIDEN_RPC_URL               required, node RPC endpoint
 *   PORT0_PROVER                required, prover (or `testnet`)
 *   PORT0_NOTE_TRANSPORT        required, note transport (or `testnet`)
 *   PORT0_FUND                  default 1000, base units sent to the registry
 *   PORT0_WAIT_SECS             default 600, funding wait timeout
 *
 * The admin is the only account that can ever change the register fee, and it
 * cannot be changed afterwards: it belongs to an account the deployer keeps, not
 * to the throwaway operator that funds the deployment.
 *
 * Run: npm run build && node scripts/deploy-registry.mjs [--yes]
 */
import { existsSync } from "node:fs";
import {
  AccountId,
  AccountInterface,
  MidenClient,
  NetworkId,
  Word,
} from "@miden-sdk/miden-sdk";
import {
  MAX_TX_FEE,
  createRegistryAccount,
  deployRegistryAccount,
  noteScript,
  p2idRoot,
  poolAuthRoots,
  readRegistryAcceptedCodeCommitments,
  wasmModule,
} from "../dist/index.js";

/**
 * The operator's own funding transaction and the registry's first transaction each cost at most
 * the protocol maximum; using it keeps the operator solvent whatever the actual fee is.
 */
const OPERATOR_TX_FEE = MAX_TX_FEE;
const REGISTRY_FIRST_TX_FEE = MAX_TX_FEE;
/** Poll interval for the funding wait. */
const POLL_MS = 5_000;

async function main() {
  // Load `.env` from the current directory when present. Real environment
  // variables take precedence; a missing file is not an error.
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const feeFaucetId = accountRef("PORT0_FEE_FAUCET_ID");
  const poolCommitment = commitment("PORT0_POOL_COMMITMENT");
  const rpcUrl = required("MIDEN_RPC_URL");
  const registerFee = positive("PORT0_REGISTER_FEE");
  const protocolFeeTo = accountRef("PORT0_PROTOCOL_FEE_TO");
  const protocolFeeShareBps = bounded("PORT0_PROTOCOL_FEE_SHARE_BPS", 10_000n);
  const allowedLpFeeBps = required("PORT0_LP_FEE_TIERS")
    .split(",")
    .map((value) => {
      const tier = BigInt(value.trim());
      if (tier <= 0n || tier >= 10_000n) {
        throw new Error(`PORT0_LP_FEE_TIERS: ${tier} is not a fee in (0, 10000) bps`);
      }
      return tier;
    });
  // The registry pays its accumulated fees with the standard P2ID note this
  // SDK ships with. A different root would need a matching consumer.
  const registryP2idRoot = p2idRoot();
  const fundAmount = BigInt(process.env.PORT0_FUND ?? "1000");
  const storeName = required("PORT0_STORE");
  const operatorRef = accountRef("PORT0_OPERATOR");
  const adminRef = accountRef("PORT0_REGISTRY_ADMIN");
  const proverUrl = required("PORT0_PROVER");
  const noteTransportUrl = required("PORT0_NOTE_TRANSPORT");
  const waitSecs = Number(process.env.PORT0_WAIT_SECS ?? "600");

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
  const operator = await resolveOperator(client);

  await confirmPolicy({
    rpcUrl,
    proverUrl,
    noteTransportUrl,
    storeName,
    operator,
    admin: AccountId.fromHex(adminRef),
    feeFaucet,
    poolCommitment,
    registerFee,
    protocolFeeTo: AccountId.fromHex(protocolFeeTo),
    protocolFeeShareBps,
    allowedLpFeeBps,
    fundAmount,
  });
  const registry = await resolveRegistry(client, accounts, operator, {
    // The account allowed to change the register fee. Required, and never the
    // operator by default: the operator is throwaway, while losing the admin
    // freezes the fee for the life of the registry.
    admin: adminRef,
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
  // The registry pays its first fee out of the funding note, so the operator must be able to
  // send at least that fee on top of its own transaction fee.
  const minimumBalance = OPERATOR_TX_FEE + REGISTRY_FIRST_TX_FEE;
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

/**
 * Prints every value that becomes registry policy and asks the deployer to
 * confirm it.
 *
 * These values are permanent for the registry: the accepted code commitment, the
 * protocol share, the LP tiers, the payout account, and the admin cannot be
 * changed after creation, and the admin cannot be rotated. A typo is therefore
 * not a retry, it is a registry that has to be replaced, so the script stops here
 * unless the deployer types the word or passes `--yes`.
 */
async function confirmPolicy(policy) {
  const address = (id) =>
    id.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
  const lines = [
    ["registry, permanent", ""],
    ["  pool code commitment", policy.poolCommitment],
    ["  protocol fee recipient", `${policy.protocolFeeTo.toString()}  ${address(policy.protocolFeeTo)}`],
    ["  protocol share of LP fee", `${policy.protocolFeeShareBps} bps`],
    ["  LP fee tiers", policy.allowedLpFeeBps.map((tier) => `${tier}`).join(", ") + " bps"],
    ["  register fee", `${policy.registerFee} base units`],
    ["  admin (fee lever, no rotation)", `${policy.admin.toString()}  ${address(policy.admin)}`],
    ["deployment", ""],
    ["  operator (funds it, throwaway)", `${policy.operator.id().toString()}  ${address(policy.operator.id())}`],
    ["  funding sent to registry", `${policy.fundAmount} base units`],
    ["  fee faucet", policy.feeFaucet.toString()],
    ["  client store", policy.storeName],
    ["  rpc / prover / transport", `${policy.rpcUrl}  ${policy.proverUrl}  ${policy.noteTransportUrl}`],
  ];
  console.log("\nRegistry parameters:");
  for (const [label, value] of lines) {
    console.log(value === "" ? label : `  ${label.padEnd(38)} ${value}`);
  }
  console.log(
    "\nThe commitment, the protocol recipient, the share, the tiers, and the admin\n" +
      "cannot be changed after creation. The register fee can be changed, but only\n" +
      "by the admin.\n",
  );

  if (process.argv.includes("--yes")) {
    console.log("Confirmed with --yes.");
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "Not a terminal, so the policy cannot be confirmed. Re-run with --yes once the " +
        "parameters above are verified.",
    );
  }
  const readline = await import("node:readline/promises");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Type `deploy` to confirm these parameters: ");
    if (answer.trim() !== "deploy") {
      throw new Error("Not confirmed; nothing was deployed.");
    }
  } finally {
    prompt.close();
  }
}

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is required. Every registry policy value and account identity is set ` +
        "explicitly; see .env.example. None of them has a default, because a wrong value " +
        "is permanent for the registry.",
    );
  }
  return value.trim();
}

/** A required account reference, normalised to its canonical hex form. */
function accountRef(name) {
  const value = required(name);
  try {
    const id =
      value.startsWith("0x") || value.startsWith("0X")
        ? AccountId.fromHex(value)
        : AccountId.fromBech32(value);
    return id.toString();
  } catch {
    throw new Error(
      `${name} is not an account id: expected 0x-prefixed hex or a bech32 address, got "${value}"`,
    );
  }
}

/** A required pool code commitment: `0x` and 64 hex characters. */
function commitment(name) {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex value`);
  }
  return value.toLowerCase();
}

/** A required positive integer. */
function positive(name) {
  const value = BigInt(required(name));
  if (value <= 0n) throw new Error(`${name} must be positive`);
  return value;
}

/** A required integer in `(0, max]`. */
function bounded(name, max) {
  const value = BigInt(required(name));
  if (value < 0n || value > max) {
    throw new Error(`${name} must be between 0 and ${max}`);
  }
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
async function resolveOperator(client) {
  const operatorRef = required("PORT0_OPERATOR");
  const account = await client.accounts.get(operatorRef);
  if (account) return account;

  throw new Error(
    `operator ${operatorRef} is not in this store (${process.env.PORT0_STORE}).\n` +
      "The operator pays for the deployment, so this script has to sign a transaction as it: " +
      "the account must be one whose keys this store holds. A wallet extension's account is " +
      "private and cannot be driven from here. The admin, by contrast, may be any account, " +
      "including your wallet, because only its id is stored.",
  );
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
    // A registry prices and allowlists the note roots of the build it was
    // created from. A note that links this interface embeds those roots, so a
    // registry created before an interface change would never consume the
    // current register note; it must not be reused.
    if (!accepts(accepted)) {
      console.log(
        `stored registry ${candidate.id().toString()} does not accept this pool code ` +
          `(${accepted.length} accepted, none equal to ${config.poolCommitment}); ` +
          "deploying a new registry",
      );
      continue;
    }
    if (matchesDeployment(candidate, config)) return candidate;
    console.log(
      `stored registry ${candidate.id().toString()} does not accept this pool code ` +
        `(${accepted.length} accepted, none equal to ${config.poolCommitment}); ` +
        "deploying a new registry",
    );
  }

  // The auth roots every pool must carry, read from a reference pool build:
  // the registry compares them on every registration, so a pool with an
  // allowlist of its own cannot be listed.
  const authRoots = await poolAuthRoots(client, {
    token0Key: [1n, 2n, 3n, 4n],
    token1Key: [5n, 6n, 7n, 8n],
    token0Symbol: "ALPHA",
    token1Symbol: "BETA",
    // Any account id satisfies the builder here; storage does not affect the
    // code commitment or the auth roots this reads.
    registryId: AccountId.fromHex(config.feeFaucetId),
    lpFeeBps: 30n,
    protocolFeeShareBps: config.protocolFeeShareBps,
    feeFaucetId: config.feeFaucetId,
  });
  return createRegistryAccount(client, {
    acceptedPoolCodeCommitment: config.poolCommitment,
    admin: config.admin,
    feeFaucetId: config.feeFaucetId,
    registerFee: config.registerFee,
    protocolFeeTo: config.protocolFeeTo,
    protocolFeeShareBps: config.protocolFeeShareBps,
    allowedLpFeeBps: config.allowedLpFeeBps,
    p2idRoot: config.registryP2idRoot,
    authRoots,
  });
}

/**
 * True when a stored registry matches this deployment: it prices and allowlists
 * this build's register note, and its permanent policy equals the configured one.
 *
 * The policy values cannot be changed after creation, so reusing a registry with
 * a different admin, payout account, share, or tier set would silently deploy
 * something other than what the deployer just confirmed.
 */
function matchesDeployment(registry, config) {
  if (!pricesCurrentNotes(registry)) return false;
  const storage = registry.storage();
  const value = (slot) =>
    storage.getItem(`pool_registry::pool_registry::${slot}`)?.word;
  const idOf = (word) => {
    if (!word) return null;
    const { Felt } = wasmModule();
    const limbs = word.toU64s();
    return AccountId.fromPrefixSuffix(
      new Felt(BigInt(limbs[3] ?? 0n)),
      new Felt(BigInt(limbs[2] ?? 0n)),
    ).toString();
  };
  const compare = (label, stored, wanted) => {
    if (stored !== null && stored.toLowerCase() === wanted.toLowerCase()) return true;
    console.log(
      `stored registry ${registry.id().toString()} has ${label} ${stored ?? "unset"}, ` +
        `configured ${wanted}; deploying a new registry`,
    );
    return false;
  };
  if (!compare("admin", idOf(value("admin")), config.admin)) return false;
  if (!compare("protocol fee recipient", idOf(value("protocol_fee_to")), config.protocolFeeTo)) {
    return false;
  }
  const share = value("protocol_fee_share_bps");
  const storedShare = share ? BigInt(share.toU64s()[0] ?? 0n).toString() : null;
  if (!compare("protocol share", storedShare, config.protocolFeeShareBps.toString())) {
    return false;
  }
  const tiers = new Set(
    (storage.getMapEntries("pool_registry::pool_registry::allowed_lp_fee_bps") ?? []).map(
      (entry) => BigInt(Word.fromHex(entry.key).toU64s()[0] ?? 0n).toString(),
    ),
  );
  const wanted = new Set(config.allowedLpFeeBps.map((tier) => tier.toString()));
  const same =
    tiers.size === wanted.size && [...wanted].every((tier) => tiers.has(tier));
  if (!same) {
    console.log(
      `stored registry ${registry.id().toString()} lists LP tiers ` +
        `[${[...tiers].join(", ")}], configured [${[...wanted].join(", ")}]; deploying a new one`,
    );
    return false;
  }
  return true;
}

/**
 * True when the registry's fee schedule and allowlist name this build's register
 * note script root, so the register note this tooling emits can be consumed.
 */
function pricesCurrentNotes(registry) {
  const scheduleSlot =
    "miden::standards::fees::policies::basic_constant_fee::fee_schedule";
  const allowlistSlot =
    "miden::standards::auth::network_account::allowed_note_scripts";
  const want = noteScript("register").root().toHex().replace(/^0x/, "").toLowerCase();
  const names = (slot) =>
    new Set(
      (registry.storage().getMapEntries(slot) ?? []).map((entry) =>
        String(entry.key).replace(/^0x/, "").toLowerCase(),
      ),
    );
  return names(scheduleSlot).has(want) && names(allowlistSlot).has(want);
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

  // Only the fee-asset notes matter. An asset-less note (a collect or config
  // note that landed here) cannot credit the vault, and consuming it costs a
  // fee the operator may not have before the funding note is claimed.
  const available = await client.notes.listAvailable({
    account: accountId.toString(),
  });
  const funding = available.filter((note) =>
    note
      .details()
      .assets()
      .fungibleAssets()
      .some((asset) => asset.faucetId().toString() === feeFaucet.toString()),
  );
  if (funding.length > 0) {
    const result = await client.transactions.consume({
      account: accountId.toString(),
      notes: funding.map((note) => note.id().toString()),
      waitForConfirmation: true,
    });
    console.log(`  consumed ${funding.length} incoming note(s)`);
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
