#!/usr/bin/env node
/**
 * Verifies a deployment end to end against a registry the run creates itself.
 *
 *   npm run preflight -- --chain testnet            # phase 0, reads only
 *   npm run preflight -- --chain mainnet --yes      # phases that spend
 *
 * Phase 0 compares what the chain has deployed with what this build produces:
 * the accepted pool code commitment, the pinned auth roots, the P2ID root, the
 * register note root, the fee policy, a live pool, and the indexer that serves
 * it. A mismatch means the deployment pins something this code no longer makes.
 *
 * Later phases create a registry, a faucet and a pool of their own. They never
 * write a production registry: the runner refuses when the target id equals the
 * one recorded for that chain.
 *
 * `PREFLIGHT.md` states what each phase covers, what it costs and what it does
 * not test. The operator comes from `PORT0_OPERATOR`; everything else is either
 * a chain constant below or created by the run.
 */
import { spawnSync } from "node:child_process";


import { writeFileSync } from "node:fs";
import {
  AccountId,
  AccountInterface,
  BasicFungibleFaucetComponent,
  FaucetType,
  MidenClient,
  NetworkId,
} from "@miden-sdk/miden-sdk";
import {
  CONTRACT_SHA256,
  GENERATED_AT,
  NOTE_FEES,
  REGISTRY_SLOTS,
  addLiquidity,
  buildFeeSponsorshipNote,
  buildLaunchNote,
  buildRegistryCollectNote,
  buildRegistryConfigNote,
  collectFees,
  createNetworkFaucet,
  createPoolAccount,
  createRegistryAccount,
  deployNetworkFaucet,
  deployPoolAccount,
  deployRegistryAccount,
  fetchPoolState,
  fungibleAssetIdWord,
  noteScript,
  outputNotesRequest,
  p2idRoot,
  poolAuthRoots,
  poolCodeCommitment,
  readRegistryAcceptedCodeCommitments,
  readRegistryAdmin,
  readRegistryFeePolicy,
  readRegistryPoolForAssets,
  readRegistryPools,
  readRegistryRegisterFee,
  registerPool,
  removeLiquidity,
  swap,
} from "../dist/index.js";

/** Base units each phase is expected to spend, from the measured schedule. */
const PHASE_COST = { 0: 0, 1: 1119, 2: 238, 3: 945, 4: 2980, 5: 371, 6: 634, 7: 600 };

/** Chains the runner knows. Constants only; the operator comes from the env. */
const CHAINS = {
  testnet: {
    rpcUrl: "https://rpc.testnet.miden.io",
    proverUrl: "testnet",
    noteTransportUrl: "testnet",
    feeFaucetId: "0x4cbdcaffe75f0a317482224dae6436",
    store: "port0-registry",
    productionRegistry: "0x8ca42fa29059dd1122da497505c681",
    indexer: "https://indexer-testnet.port0.sh",
  },
  mainnet: {
    rpcUrl: "https://rpc.cedar.miden.io",
    proverUrl: "https://tx-prover.cedar.miden.io",
    noteTransportUrl: "https://transport.cedar.miden.io",
    feeFaucetId: "0xe69e6ca6e39df1b10c1e5399399feb",
    store: "port0-mainnet",
    productionRegistry: "0x219eab0784be9111213edf3324795f",
    indexer: "https://indexer.port0.sh",
  },
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = undefined) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
/** Every `--code`, in order: phase 7 needs one per keyed account it creates. */
const codes = (() => {
  const found = [];
  args.forEach((arg, index) => {
    if (arg === "--code" && args[index + 1]) found.push(args[index + 1]);
  });
  const combined = value("--codes");
  if (combined) found.push(...combined.split(",").map((part) => part.trim()).filter(Boolean));
  return found;
})();

if (flag("--help") || flag("-h")) {
  console.log(
    [
      "Usage: npm run preflight -- --chain <testnet|mainnet> [options]",
      "",
      "  --chain <name>    required; selects the chain constants and the store",
      "  --phase <list>    phases to run, for example 0 or 0,1 (default 0)",
      "  --yes             required for any phase that spends",
      "  --report <path>   write every observed value as JSON",
      "  --key <path>      import a key for the operator if the store lacks one",
      "  --new-operator    create the operator account instead of importing",
      "  --code <code>     invitation code for the phase 7 tester account",
      "  --codes a,b       the same, in one argument",
      "  --tester <id>     reuse a keyed account already in the store for phase 7",
      "",
      "Phases: 0 reads, 1 registry, 2 fee lever, 3 faucet, 4 pool, 5 swap, 6 collects.",
      "PREFLIGHT.md has the full account of each.",
    ].join("\n"),
  );
  process.exit(0);
}

const chainName = value("--chain");
if (!chainName || !(chainName in CHAINS)) {
  console.error(`--chain is required and must be one of: ${Object.keys(CHAINS).join(", ")}`);
  process.exit(2);
}
const CHAIN = CHAINS[chainName];
const phases = (value("--phase", "0") ?? "0")
  .split(",")
  .map((part) => Number(part.trim()))
  .filter((n) => Number.isInteger(n) && n in PHASE_COST);
if (phases.length === 0) {
  console.error("--phase listed no known phase");
  process.exit(2);
}
// Phase 7 needs one keyed account that is neither the operator nor the admin:
// the party the contracts must refuse. An account named by --tester is already
// registered, so it needs no code and prompts for none.
const testerProvided = Boolean(value("--tester"));
const codesNeeded = phases.includes(7) && !testerProvided ? 1 : 0;
if (codesNeeded > codes.length && process.stdin.isTTY) {
  const readline = await import("node:readline/promises");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (codes.length < codesNeeded) {
      const label = "tester account";
      const answer = (await prompt.question(`Invitation code for the ${label}: `)).trim();
      if (answer) codes.push(answer);
      else break;
    }
  } finally {
    prompt.close();
  }
}

const spending = phases.some((n) => PHASE_COST[n] > 0);
if (spending && !flag("--yes")) {
  console.error("A spending phase needs --yes. Nothing was done.");
  process.exit(2);
}

/* Output ------------------------------------------------------------------ */

const WIDTH = 64;
const line = (char = "─") => char.repeat(WIDTH);
const section = (title) => {
  console.log(`\n${title}`);
  console.log(line());
};
const row = (label, observed, verdict = "") => {
  const pad = label.padEnd(30);
  const mark = verdict === "" ? " " : verdict === true ? "✓" : "✗";
  console.log(`  ${mark} ${pad} ${observed}`);
};
const info = (label, observed) => row(label, observed, "");
const pass = (label, observed) => row(label, observed, true);
const fail = (label, observed) => row(label, observed, false);
const note = (text) => console.log(`    ${text}`);

let failures = 0;
const record = [];

/** A comparison against the build: records the observed and the expected value. */
function check(id, label, observed, expected, equal = (a, b) => a === b) {
  const ok = equal(observed, expected);
  if (!ok) failures += 1;
  record.push({ id, label, observed: String(observed), expected: String(expected), pass: ok });
  if (ok) pass(label, String(observed));
  else {
    fail(label, String(observed));
    note(`expected ${expected}`);
  }
  return ok;
}

/** An observation with no expectation, kept for the report. */
function observe(id, label, observed) {
  record.push({ id, label, observed: String(observed), expected: null, pass: null });
  info(label, String(observed));
}

/* Formatting -------------------------------------------------------------- */

let feeDecimals = 6;
const UNIT = () => (chainName === "mainnet" ? "USDCX" : "USDCX");

/** Base units as a decimal amount, trimmed, with the unit. */
function money(baseUnits) {
  const scale = 10n ** BigInt(feeDecimals);
  const value = BigInt(baseUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(feeDecimals, "0").replace(/0+$/, "");
  const decimal = `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
  return `${decimal} ${UNIT()} (${value} base units)`;
}

const short = (id) => {
  const hex = id.toString();
  return hex.length <= 22 ? hex : `${hex.slice(0, 12)}…${hex.slice(-8)}`;
};

const bech32 = (id) => {
  try {
    return id.toBech32(NetworkId[chainName](), AccountInterface.BasicWallet);
  } catch {
    return id.toString();
  }
};

/** The canonical hex form of a Word4 compared against a build value. */
const word4Hex = (word) =>
  "0x" + Array.from(word).map((felt) => BigInt(felt).toString(16).padStart(16, "0")).join("");


/** Polls the pool until `ready` holds: notes are consumed in a later block. */
async function waitForPoolState(client, getAccount, poolId, ready, waitSecs = 180) {
  const until = Date.now() + waitSecs * 1000;
  for (;;) {
    await client.syncChain();
    const state = await fetchPoolState(getAccount, poolId);
    if (ready(state)) return state;
    if (Date.now() > until) return state;
    await sleep(3_000);
  }
}


/** Reads an account's balance from the chain, importing it over the stored copy. */
async function freshBalance(client, accountId, feeFaucet) {
  await client.syncChain();
  try {
    await client.accounts.import(accountId.toString());
  } catch {
    // An account the store already tracks can refuse the import; the copy then
    // is as good as it gets.
  }
  return client.accounts.getBalance(accountId, feeFaucet);
}

/** Runs the collect script, which is the tool built for this purpose. */
function runCollect(kind, extra, registryId) {
  const env = {
    ...process.env,
    PORT0_REGISTRY_ID: registryId?.toString() ?? process.env.PORT0_REGISTRY_ID ?? "",
    PORT0_OPERATOR: process.env.PORT0_OPERATOR,
    PORT0_STORE: CHAIN.store,
    MIDEN_RPC_URL: CHAIN.rpcUrl,
    PORT0_PROVER: CHAIN.proverUrl,
    PORT0_NOTE_TRANSPORT: CHAIN.noteTransportUrl,
    PORT0_FEE_FAUCET_ID: CHAIN.feeFaucetId,
  };
  const args = ["scripts/collect-fees.mjs", kind, ...(extra ?? []), "--submit"];
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 900_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return { ok: result.status === 0, output };
}

/* Phase 0 ----------------------------------------------------------------- */



async function phase0(client, operator, feeFaucet) {
  section("Phase 0 · deployed conformance (read only)");
  note("Lines about MASM source directories are expected: the npm package ships");
  note("compiled packages, not sources, and the checks use the packaged bytes.");
  // Which artifacts this comparison is against. Without them a forgotten
  // `generate` would pass against an older deployment.
  observe("0.0.1", "contracts built at", GENERATED_AT);
  const kinds = Object.keys(CONTRACT_SHA256).sort();
  observe("0.0.2", "contract kinds", kinds.join(", "));
  for (const kind of ["pool", "registry"]) {
    if (CONTRACT_SHA256[kind]) observe(`0.0.${3 + kinds.indexOf(kind)}`, `${kind} sha256`, CONTRACT_SHA256[kind]);
  }

  // What this build produces.
  const mock = await MidenClient.createMock();
  const referenceRegistry = (await mock.accounts.create({ storage: "public" })).id();
  const faucetOf = async (symbol) =>
    (
      await mock.accounts.create({
        type: FaucetType.FungibleFaucet,
        symbol,
        decimals: 8,
        maxSupply: 1_000_000_000n,
        storage: "public",
      })
    ).id();
  const refToken0 = await faucetOf("ALPHA");
  const refToken1 = await faucetOf("BETA");
  const refFee = await faucetOf("FEE");
  const referencePool = {
    token0Key: fungibleAssetIdWord(refToken0),
    token1Key: fungibleAssetIdWord(refToken1),
    token0Symbol: "ALPHA",
    token1Symbol: "BETA",
    registryId: referenceRegistry,
    lpFeeBps: 30n,
    protocolFeeShareBps: 10n,
    feeFaucetId: refFee,
  };
  const builtCommitment = await poolCodeCommitment(mock, referencePool);
  // The auth roots carry the fee asset, which is data, not code: build them
  // against this chain's fee faucet so the registry is created with the right one.
  const builtRoots = await poolAuthRoots(mock, {
    ...referencePool,
    feeFaucetId: feeFaucet,
  });
  const builtP2id = word4Hex(p2idRoot());
  const builtRegisterRoot = Array.from(noteScript("register").root().toU64s()).map((v) => BigInt(v));

  const production = AccountId.fromHex(CHAIN.productionRegistry);
  const getAccount = async (id) => {
    try {
      return await client.accounts.getOrImport(id.toString());
    } catch {
      return null;
    }
  };

  // 0.1 the registry accepts this build's pool code.
  const accepted = await readRegistryAcceptedCodeCommitments(getAccount, production);
  const acceptedHex = accepted.map(word4Hex).map((hex) =>
    "0x" +
    hex
      .slice(2)
      .match(/.{16}/g)
      .map((limb) => limb.match(/../g).reverse().join(""))
      .join(""),
  );
  check(
    "0.1",
    "accepted pool code commitment",
    acceptedHex[0] ?? "(none)",
    builtCommitment,
    (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
  );

  // 0.2 the pinned pool auth roots.
  const registryAccount = await getAccount(production);
  const storage = registryAccount.storage();
  const slotWord = (slot) => {
    const word = storage.getItem(slot)?.word;
    return word ? Array.from(word.toU64s()).map((v) => BigInt(v)) : null;
  };
  const rootPairs = [
    [REGISTRY_SLOTS.expectedNoteAllowlistRoot, builtRoots.noteAllowlistRoot, "note allowlist root"],
    [REGISTRY_SLOTS.expectedTxScriptAllowlistRoot, builtRoots.txScriptAllowlistRoot, "tx script allowlist root"],
    [REGISTRY_SLOTS.expectedFeeScheduleRoot, builtRoots.feeScheduleRoot, "fee schedule root"],
    [REGISTRY_SLOTS.expectedFeeAssetId, fungibleAssetIdWord(feeFaucet), "fee asset root"],
    [REGISTRY_SLOTS.expectedActiveFeePolicyRoot, builtRoots.activeFeePolicyRoot, "active fee policy root"],
    [REGISTRY_SLOTS.expectedAllowedFeePolicyRoots, builtRoots.allowedFeePolicyRoots, "allowed fee policy roots"],
  ];
  rootPairs.forEach(([slot, expected, label], index) => {
    const observed = slotWord(slot);
    check(
      `0.2.${index + 1}`,
      label,
      observed ? word4Hex(observed) : "(missing)",
      word4Hex(expected),
      (a, b) => a === b,
    );
  });

  // 0.3 and 0.4 the P2ID root and the register note root.
  const pinnedP2id = slotWord(REGISTRY_SLOTS.p2idRoot);
  check("0.3", "pinned p2id root", pinnedP2id ? word4Hex(pinnedP2id) : "(missing)", builtP2id);
  const registerSlot = slotWord(REGISTRY_SLOTS.registerNoteRoot);
  check(
    "0.4",
    "pinned register note root",
    registerSlot ? word4Hex(registerSlot) : "(missing)",
    word4Hex(builtRegisterRoot),
  );

  // 0.5 the policy.
  const admin = await readRegistryAdmin(getAccount, production);
  const policy = await readRegistryFeePolicy(getAccount, production);
  const registerFee = await readRegistryRegisterFee(getAccount, production);
  observe("0.5.1", "admin", `${admin.toString()}  ${bech32(admin)}`);
  observe("0.5.2", "protocol fee recipient", `${policy.protocolFeeTo.toString()}  ${bech32(policy.protocolFeeTo)}`);
  observe("0.5.3", "protocol share", `${policy.protocolFeeShareBps} bps`);
  observe("0.5.4", "LP fee tiers", `${policy.allowedLpFeeBps.map(String).join(", ")} bps`);
  observe("0.5.5", "register fee", money(registerFee));

  // 0.6 to 0.8 a live pool.
  const pools = await readRegistryPools(getAccount, production);
  observe("0.6.0", "registered pools", String(pools.length));
  if (pools.length > 0) {
    const entry = pools[0];
    const state = await fetchPoolState(getAccount, entry.poolId);
    const commitment = word4Hex(entry.codeCommitment);
    const commitmentHex =
      "0x" +
      commitment
        .slice(2)
        .match(/.{16}/g)
        .map((limb) => limb.match(/../g).reverse().join(""))
        .join("");
    check(
      "0.6",
      `live pool ${short(entry.poolId)} code`,
      commitmentHex,
      builtCommitment,
      (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    );
    check("0.7.1", "pool registry pointer", state.registryId.toString(), CHAIN.productionRegistry);
    observe(
      "0.7.2",
      "pool fee / share",
      `${state.fees.lpFeeBps} / ${state.fees.protocolFeeShareBps} bps`,
    );
    const poolAccount = await getAccount(entry.poolId);
    try {
      const meta = BasicFungibleFaucetComponent.fromAccount(poolAccount);
      const supply = BigInt(meta.maxSupply().asInt());
      const expected = (1n << 63n) - (1n << 31n);
      check("0.8.1", "LP symbol shape", /^PO[A-Z]{1,10}$/.test(meta.symbol().toString()) ? "ok" : meta.symbol().toString(), "ok");
      check("0.8.2", "LP decimals", String(meta.decimals()), "0");
      check("0.8.3", "LP max supply", supply.toString(), expected.toString());
    } catch (error) {
      fail("0.8", "LP faucet metadata");
      note(error?.message ?? String(error));
    }
  }

  // 0.9 the chain's fee faucet, and its decimals for every amount printed.
  const chainFaucet = (await client.feeFaucetId()).toString();
  check("0.9", "chain fee faucet", chainFaucet, CHAIN.feeFaucetId, (a, b) => String(a).toLowerCase() === String(b).toLowerCase());
  try {
    const faucetAccount = await getAccount(feeFaucet);
    feeDecimals = BasicFungibleFaucetComponent.fromAccount(faucetAccount).decimals();
  } catch {
    note("the fee faucet's metadata is unreadable; amounts use 6 decimals");
  }

  // 0.10 the operator exists here and can act.
  observe("0.10.1", "operator", `${operator.id().toString()}  ${bech32(operator.id())}`);
  observe(
    "0.10.2",
    "allowlist",
    "not queried: the node gates account creation, and this operator already exists",
  );

  // 0.12 the indexer that serves the app.
  try {
    const status = await (await fetch(`${CHAIN.indexer}/status`)).json();
    check("0.12.1", "indexer registry", String(status.registry_id).toLowerCase(), CHAIN.productionRegistry);
    check("0.12.2", "indexer pool count", String(status.known_pools), String(pools.length));
    observe("0.12.3", "indexer height", String(status.last_registry_block));

    // The app's prices come from the indexer, so one pool's reserves must match
    // the chain's own read. A count cannot catch a diverged indexer.
    if (pools.length > 0) {
      const entry = pools[0];
      const row = await (await fetch(`${CHAIN.indexer}/pools/${entry.poolId.toString().replace(/^0x/, "")}`)).json();
      const state = await fetchPoolState(getAccount, entry.poolId);
      check(
        "0.12.4",
        "indexer reserves match the chain",
        `${row.reserve0}/${row.reserve1}`,
        `${state.reserve0}/${state.reserve1}`,
      );
    }
  } catch (error) {
    fail("0.12", "indexer reachable");
    note(error?.message ?? String(error));
  }
  return { pools: pools.length, registerFee, commitment: builtCommitment, authRoots: builtRoots };
}


/* Helpers shared by the spending phases -------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => BigInt(Math.floor(Date.now() / 1000));
const deadline = () => now() + 3600n;

/** Polls until the account has a consumable note, then returns its id. */
async function waitForNote(client, accountId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await client.syncChain();
    const notes = await client.notes.listAvailable({ account: accountId });
    if (notes[0]) return notes[0].id().toString();
    await sleep(3_000);
  }
  throw new Error(`no consumable note appeared for ${accountId}`);
}

/** Sends a public P2ID note from the operator and returns the transaction id. */
async function fund(client, operator, feeFaucet, to, amount) {
  const { txId } = await client.transactions.send({
    account: operator.id().toString(),
    to,
    token: feeFaucet.toString(),
    amount,
    type: "public",
    waitForConfirmation: true,
  });
  return txId;
}

async function balanceOf(client, accountId, feeFaucet) {
  return client.accounts.getBalance(accountId, feeFaucet);
}

/** Polls a reader until it answers `expected`, or the deadline passes. */
async function waitUntil(read, expected, waitSecs = 300) {
  const until = Date.now() + waitSecs * 1000;
  for (;;) {
    const value = await read();
    if (String(value) === String(expected)) return true;
    if (Date.now() > until) return false;
    await sleep(4_000);
  }
}

/* Phases that spend ------------------------------------------------------- */

/** Phase 1: a registry of this run's own, funded and deployed. */
async function phase1(client, operator, feeFaucet, built) {
  section("Phase 1 · preflight registry");
  const before = await balanceOf(client, operator.id(), feeFaucet);

  const registry = await createRegistryAccount(client, {
    acceptedPoolCodeCommitment: built.commitment,
    feeFaucetId: feeFaucet,
    registerFee: 119n,
    protocolFeeTo: operator.id(),
    protocolFeeShareBps: 1200n,
    allowedLpFeeBps: [5n, 30n, 100n],
    p2idRoot: p2idRoot(),
    // The admin is the operator, which is what makes the lever testable
    // without a wallet. A run's registry never outlives the run.
    admin: operator.id(),
    authRoots: built.authRoots,
  });
  const registryId = registry.id();
  if (registryId.toString() === CHAIN.productionRegistry) {
    fail("registry is not the production one", registryId.toString());
    throw new Error("refusing to write the production registry");
  }
  pass("created", registryId.toString());

  // The registry pays its own first fee out of the funding note.
  const fundingTx = await fund(client, operator, feeFaucet, registryId.toString(), 1000n);
  pass("funded 1000 base units", fundingTx.toHex());
  const noteId = await waitForNote(client, registryId.toString());
  const { txId } = await deployRegistryAccount(client, registryId, noteId, {
    waitForConfirmation: true,
  });
  pass("deployed", txId.toHex());

  const getAccount = (id) => client.accounts.get(id);
  const admin = await readRegistryAdmin(getAccount, registryId);
  check("1.1", "admin is the operator", admin.toString(), operator.id().toString());
  const accepted = await readRegistryAcceptedCodeCommitments(getAccount, registryId);
  const acceptedHex = accepted.map((word) =>
    "0x" +
    Array.from(word)
      .map((felt) => BigInt(felt).toString(16).padStart(16, "0"))
      .map((limb) => limb.match(/../g).reverse().join(""))
      .join(""),
  );
  check("1.2", "accepted commitment", acceptedHex[0] ?? "(none)", built.commitment, (a, b) =>
    String(a).toLowerCase() === String(b).toLowerCase(),
  );
  const fee = await readRegistryRegisterFee(getAccount, registryId);
  check("1.3", "register fee", money(fee), money(119n));
  const spent = before - (await balanceOf(client, operator.id(), feeFaucet));
  observe("1.4", "spent", money(spent));
  return { registryId };
}

/** Phase 2: the admin lever, signed by the operator as the registry's admin. */
async function phase2(client, operator, feeFaucet, registryId) {
  section("Phase 2 · admin fee lever");
  const before = await balanceOf(client, operator.id(), feeFaucet);
  const getAccount = (id) => client.accounts.get(id);

  const setFee = async (amount) => {
    const note = buildRegistryConfigNote({
      sender: operator.id(),
      registryId,
      registerFee: amount,
    });
    // The config note is priced at zero and the registry pays its own fee, so no
    // sponsorship is attached.
    const request = await outputNotesRequest(client, [note], registryId);
    const { txId } = await client.transactions.submit(operator.id(), request);
    await client.transactions.waitFor(txId);
    const ok = await waitUntil(async () => {
      await client.syncChain();
      return readRegistryRegisterFee(getAccount, registryId);
    }, amount);
    return { ok, txId };
  };

  const live = await readRegistryRegisterFee(getAccount, registryId);
  check("2.1", "fee before", money(live), money(119n));

  const raised = await setFee(120n);
  raised.ok ? pass("raised to 120", raised.txId.toHex()) : fail("raised to 120", "not consumed");
  if (!raised.ok) failures += 1;

  const reverted = await setFee(119n);
  reverted.ok ? pass("reverted to 119", reverted.txId.toHex()) : fail("reverted to 119", "not consumed");
  if (!reverted.ok) failures += 1;

  const spent = before - (await balanceOf(client, operator.id(), feeFaucet));
  observe("2.2", "spent", money(spent));
}

/** Phase 3: a network faucet, funded, deployed and launched once. */
async function phase3(client, operator, feeFaucet) {
  section("Phase 3 · network faucet");
  const before = await balanceOf(client, operator.id(), feeFaucet);
  const symbol = "PTST";
  const maxSupply = 1_000_000n;

  const faucet = await createNetworkFaucet(client, {
    name: "port0 preflight token",
    symbol,
    decimals: 0,
    maxSupply,
    owner: operator.id(),
    feeFaucetId: feeFaucet,
  });
  const faucetId = faucet.id();
  pass("created", faucetId.toString());

  const fundingTx = await fund(client, operator, feeFaucet, faucetId.toString(), 112n);
  const noteId = await waitForNote(client, faucetId.toString());
  const { txId: deployTx } = await deployNetworkFaucet(client, faucetId, noteId, {
    waitForConfirmation: true,
  });
  pass("deployed", `${deployTx.toHex()} · ${fundingTx.toHex()}`);

  const launch = buildLaunchNote({
    sender: operator.id(),
    faucetId,
    recipient: operator.id(),
  });
  const request = await outputNotesRequest(client, [launch], faucetId);
  const { txId: launchTx } = await client.transactions.submit(operator.id(), request);
  await client.transactions.waitFor(launchTx);
  pass("launch emitted", launchTx.toHex());

  // The supply arrives as a payout note, so it is not in the wallet yet.
  let held = 0n;
  for (let attempt = 0; attempt < 20 && held === 0n; attempt += 1) {
    await client.syncChain();
    const notes = await client.notes.listAvailable({ account: operator.id().toString() });
    if (notes.length > 0) {
      await client.transactions.consume({
        account: operator.id().toString(),
        notes: notes.map((note) => note.id().toString()),
        waitForConfirmation: true,
      });
    }
    await client.syncChain();
    held = await balanceOf(client, operator.id(), faucetId);
    if (held === 0n) await sleep(3_000);
  }
  check("3.0", "payout received", held.toString(), maxSupply.toString());

  const readSupply = async () => {
    await client.syncChain();
    const account = await client.accounts.get(faucetId.toString());
    return BigInt(BasicFungibleFaucetComponent.fromAccount(account).maxSupply().asInt());
  };
  const supply = await readSupply();
  check("3.1", "supply equals max supply", supply.toString(), maxSupply.toString());

  // A second launch must not mint again: the account's `launched` flag holds.
  const again = buildLaunchNote({ sender: operator.id(), faucetId, recipient: operator.id() });
  const againRequest = await outputNotesRequest(client, [again], faucetId);
  const { txId: againTx } = await client.transactions.submit(operator.id(), againRequest);
  await client.transactions.waitFor(againTx);
  await sleep(8_000);
  const after = await readSupply();
  check("3.2", "second launch minted nothing", after.toString(), maxSupply.toString());

  const spent = before - (await balanceOf(client, operator.id(), feeFaucet));
  observe("3.3", "spent", money(spent));
  return { faucetId, symbol, maxSupply };
}

/** Phase 4: a pool over the launched token and the fee asset, registered. */
async function phase4(client, operator, feeFaucet, registryId, faucet) {
  section("Phase 4 · pool, registration and LP");
  const before = await balanceOf(client, operator.id(), feeFaucet);
  const getAccount = (id) => client.accounts.get(id);
  // The live fee, not a constant: phase 2 may have been skipped or left at 120.
  const liveFee = await readRegistryRegisterFee(getAccount, registryId);

  const pool = await createPoolAccount(client, {
    token0Key: fungibleAssetIdWord(faucet.faucetId),
    token1Key: fungibleAssetIdWord(feeFaucet),
    token0Symbol: faucet.symbol,
    token1Symbol: "USDCX",
    registryId,
    lpFeeBps: 30n,
    protocolFeeShareBps: 1200n,
    feeFaucetId: feeFaucet,
    noteFees: NOTE_FEES,
  });
  const poolId = pool.id();
  pass("created", poolId.toString());

  const fundingTx = await fund(client, operator, feeFaucet, poolId.toString(), 133n);
  const noteId = await waitForNote(client, poolId.toString());
  const { txId: deployTx } = await deployPoolAccount(client, poolId, noteId, {
    waitForConfirmation: true,
  });
  pass("deployed", `${deployTx.toHex()} · ${fundingTx.toHex()}`);

  await registerPool(
    client,
    { registryId, feeFaucetId: feeFaucet, registerFee: liveFee },
    { sender: operator.id(), poolId, asset0: faucet.faucetId, asset1: feeFaucet },
    { submit: true, waitForConfirmation: true },
  );
  pass("registered", poolId.toString());

  // The registry consumes the register note in a later block, so the mapping
  // appears after the emit confirms.
  let mapped = null;
  for (let attempt = 0; attempt < 40 && !mapped; attempt += 1) {
    await client.syncChain();
    mapped = await readRegistryPoolForAssets(getAccount, registryId, faucet.faucetId, feeFaucet).catch(
      () => null,
    );
    if (!mapped) await sleep(3_000);
  }
  check("4.1", "pair maps to the pool", mapped ? mapped.toString() : "(none)", poolId.toString());

  const config = { poolId, feeFaucetId: feeFaucet, noteFees: NOTE_FEES };
  const state = await fetchPoolState(getAccount, poolId);
  check("4.2", "registry pointer", state.registryId.toString(), registryId.toString());
  check("4.3", "fee tier", `${state.fees.lpFeeBps}`, "30");
  check("4.4", "protocol share", `${state.fees.protocolFeeShareBps}`, "1200");

  const poolAccount = await client.accounts.get(poolId.toString());
  const meta = BasicFungibleFaucetComponent.fromAccount(poolAccount);
  check("4.5", "LP symbol", meta.symbol().toString(), `PO${faucet.symbol}USDCX`.slice(0, 12));
  check("4.6", "LP decimals", `${meta.decimals()}`, "0");

  // Deposit. The first mint locks MINIMUM_LIQUIDITY = 1000 LP, so sqrt(x*y) has
  // to clear it: 500,000 of the launched token against 2,000 base units of the
  // fee asset gives about 31,622 LP, and leaves half the supply for the swap.
  const deposit0 = 500_000n;
  const deposit1 = 2_000n;
  // The transaction is built from this account's vault, so read it fresh.
  await client.syncChain();
  await client.accounts.get(operator.id().toString());
  const mint = await addLiquidity(
    client,
    config,
    state,
    {
      sender: operator.id(),
      recipient: operator.id(),
      amount0: deposit0,
      amount1: deposit1,
      slippageBps: 100n,
      deadline: deadline(),
    },
    { submit: true, waitForConfirmation: true },
  );
  const afterMint = await waitForPoolState(client, getAccount, poolId, (st) => st.reserve0 > 0n);
  check("4.7", "reserves after deposit", `${afterMint.reserve0}/${afterMint.reserve1}`, `${deposit0}/${deposit1}`);
  check(
    "4.8",
    "LP supply = user liquidity + locked minimum",
    afterMint.lpSupply.toString(),
    (mint.quote.liquidityToUser + 1000n).toString(),
  );

  const spent = before - (await balanceOf(client, operator.id(), feeFaucet));
  observe("4.9", "spent", money(spent));
  return { poolId, config, state: afterMint, token0: faucet.faucetId };
}

/** Phase 5: a swap, and the guards that refuse a bad one. */
async function phase5(client, operator, feeFaucet, pool) {
  section("Phase 5 · swap and guards");
  const before = await balanceOf(client, operator.id(), feeFaucet);
  const getAccount = (id) => client.accounts.get(id);

  const state = await fetchPoolState(getAccount, pool.poolId);
  const kBefore = state.reserve0 * state.reserve1;

  const result = await swap(
    client,
    pool.config,
    state,
    {
      sender: operator.id(),
      recipient: operator.id(),
      tokenIn: pool.token0,
      amountIn: 10_000n,
      slippageBps: 100n,
      deadline: deadline(),
    },
    { submit: true, waitForConfirmation: true },
  );
  pass("swap emitted", result.note.id().toString());

  const after = await waitForPoolState(
    client,
    getAccount,
    pool.poolId,
    (st) => st.protocolPot.amount0 + st.protocolPot.amount1 > 0n,
  );
  const kAfter = after.reserve0 * after.reserve1;
  check("5.1", "k never decreases", kAfter >= kBefore ? "yes" : "no", "yes");
  const pot = after.protocolPot.amount0 + after.protocolPot.amount1;
  check("5.2", "protocol pot grew", pot > 0n ? "yes" : "no", "yes");

  // The quoter must refuse a pool with nothing on one side. The state is
  // fabricated, so this exercises the SDK's guard without deploying a pool.
  const empty = { ...after, reserve0: 0n, reserve1: 0n, lpSupply: 0n };
  // `swap` throws for an empty side before it returns a promise, so the refusal
  // is caught synchronously.
  let refused = false;
  try {
    await swap(
      client,
      pool.config,
      empty,
      {
        sender: operator.id(),
        recipient: operator.id(),
        tokenIn: pool.token0,
        amountIn: 1n,
        slippageBps: 0n,
        deadline: deadline(),
      },
      { submit: false },
    );
  } catch {
    refused = true;
  }
  check("5.3", "quoter refuses an empty pool", refused ? "refused" : "quoted", "refused");

  // A token the pool does not hold must be refused too.
  // A real account id that is not a token in this pool: the pool itself.
  const outsider = pool.poolId;
  let unknown = false;
  try {
    await swap(
      client,
      pool.config,
      after,
      {
        sender: operator.id(),
        recipient: operator.id(),
        tokenIn: outsider,
        amountIn: 1n,
        slippageBps: 0n,
        deadline: deadline(),
      },
      { submit: false },
    );
  } catch {
    unknown = true;
  }
  check("5.4", "quoter refuses a foreign token", unknown ? "refused" : "quoted", "refused");

  const spent = before - (await balanceOf(client, operator.id(), feeFaucet));
  observe("5.5", "spent", money(spent));
}

/** Phase 6: the two collects, their holds, and the payout. */
async function phase6(client, operator, feeFaucet, registryId, pool) {
  section("Phase 6 · fee sweeps");
  const before = await balanceOf(client, operator.id(), feeFaucet);
  const getAccount = (id) => client.accounts.get(id);

  // Registry: it holds the register fee this run paid it. The sweep is the
  // `fees:collect` script's job, so the runner calls it rather than hand-building
  // a note and its sponsorship a second time.
  const registryHeld = await freshBalance(client, registryId, feeFaucet);
  observe("6.1", "registry holds", money(registryHeld));
  if (registryHeld > 119n) {
    const sweep = runCollect("registry", [], registryId);
    sweep.ok ? pass("registry swept", "fees:collect registry") : fail("registry swept", "script failed");
    if (!sweep.ok) {
      failures += 1;
      sweep.output.slice(-4).forEach((line) => note(line));
    }
    // The sweep pays the registry's fixed recipient, which is the operator here.
    // Read the note it received rather than inferring from balances.
    const incomingNow = async () => {
      await client.syncChain();
      return (await client.notes.listAvailable({ account: operator.id().toString() }))
        .flatMap((note) => {
          try {
            return note.assets().fungibleAssets();
          } catch {
            return [];
          }
        })
        .filter((asset) => asset.faucetId().toString() === feeFaucet.toString())
        .reduce((sum, asset) => sum + asset.amount(), 0n);
    };
    let incoming = 0n;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      incoming = await incomingNow();
      if (incoming > 0n) break;
      await sleep(3_000);
    }
    const left = await freshBalance(client, registryId, feeFaucet);
    const swept = registryHeld - left;
    // The destination is fixed by the registry, so the check that it received
    // the funds is the balance, not a note this client may never see.
    const recipientBefore = await freshBalance(client, operator.id(), feeFaucet);
    observe("6.3", "swept", money(swept));
    observe("6.4", "visible payout notes", money(incoming));
    observe("6.5", "recipient balance", money(recipientBefore));
    if (incoming > 0n) {
      await client.transactions.consume({
        account: operator.id().toString(),
        notes: (await client.notes.listAvailable({ account: operator.id().toString() })).map((note) =>
          note.id().toString(),
        ),
        waitForConfirmation: true,
      });
    }
    // The script states its own hold and payout; the runner records the residue
    // rather than inventing a number, and asserts only that the sweep moved funds.
    check("6.2", "registry balance decreased", left < registryHeld ? "yes" : "no", "yes");
    observe("6.3", "registry residue", money(left));
  }

  // Pool: the protocol pot from the swap.
  const state = await fetchPoolState(getAccount, pool.poolId);
  observe("6.4", "pool protocol pot", `${state.protocolPot.amount0}/${state.protocolPot.amount1}`);
  if (state.protocolPot.amount0 > 0n || state.protocolPot.amount1 > 0n) {
    const sweep = runCollect("pool", [pool.poolId.toString()], registryId);
    sweep.ok ? pass("pool swept", "fees:collect pool") : fail("pool swept", "script failed");
    if (!sweep.ok) {
      failures += 1;
      sweep.output.slice(-4).forEach((line) => note(line));
    }
    const after = await waitForPoolState(
      client,
      getAccount,
      pool.poolId,
      (st) => st.protocolPot.amount0 === 0n && st.protocolPot.amount1 === 0n,
    );
    check("6.5", "pot emptied", `${after.protocolPot.amount0}/${after.protocolPot.amount1}`, "0/0");
  }

  // Burn every LP the operator holds: the pool must keep the locked minimum
  // and stay solvent, never draining to zero.
  const lp = await freshBalance(client, operator.id(), pool.poolId);
  observe("6.4", "LP held", lp.toString());
  if (lp > 0n) {
    const fresh = await fetchPoolState(getAccount, pool.poolId);
    await removeLiquidity(
      client,
      pool.config,
      fresh,
      {
        sender: operator.id(),
        recipient: operator.id(),
        amountLp: lp,
        slippageBps: 100n,
        deadline: deadline(),
      },
      { submit: true, waitForConfirmation: true },
    );
    const after = await waitForPoolState(
      client,
      getAccount,
      pool.poolId,
      (st) => st.lpSupply === 1000n,
    );
    check("6.5", "locked minimum remains", after.lpSupply.toString(), "1000");
    check("6.6", "reserve0 stays non-zero", after.reserve0 > 0n ? "yes" : "no", "yes");
    check("6.7", "reserve1 stays non-zero", after.reserve1 > 0n ? "yes" : "no", "yes");
  }

  const spent = before - (await balanceOf(client, operator.id(), feeFaucet));
  observe("6.7", "spent", money(spent));
}


/** Phase 7: the operations a second keyed account is needed to attempt. */
async function phase7(client, operator, feeFaucet, chain, codes) {
  section("Phase 7 · refused operations from a second account");
  note("The tester is a keyed account distinct from the operator and the admin,");
  note("so it is the party the contracts must refuse. 7.3 (a keyed faucet through");
  note("the invitation gate) is closed: no token allowlist exists to test.");
  const before = await balanceOf(client, operator.id(), feeFaucet);
  const getAccount = (id) => client.accounts.get(id);


  /** Creates and registers a keyed wallet from a code, then drains its funding. */
  const makeTester = async (code, label) => {
    const valid = await client.accounts.isInvitationCodeValid(code).catch(() => null);
    if (valid === false) {
      observe("7.0", `${label} code`, "rejected by the node: unknown or already registered");
      return null;
    }
    const account = await client.accounts.create({ storage: "public" });
    await client.accounts.register({ account, invitationCode: code });
    // Registration pays a funding note; consume it so the account can act.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await client.syncChain();
      const notes = await client.notes.listAvailable({ account: account.id().toString() });
      if (notes.length === 0) break;
      await client.transactions.consume({
        account: account.id().toString(),
        notes: notes.map((note) => note.id().toString()),
        waitForConfirmation: true,
      });
    }
    const held = await freshBalance(client, account.id(), feeFaucet);
    observe("7.0", `${label} registered`, `${account.id().toString()} · ${money(held)}`);
    return account;
  };

  let tester = null;
  const existingTester = value("--tester");
  if (existingTester) {
    const id = AccountId.fromHex(existingTester.startsWith("0x") ? existingTester : `0x${existingTester}`);
    tester = await client.accounts.get(id.toString()).catch(() => null);
    if (!tester) {
      observe("7.0", "tester", `${id.toString()} is not in this store`);
      tester = null;
    }
  } else if (chainName === "testnet") {
    const account = await client.accounts.create({ storage: "public" });
    await fund(client, operator, feeFaucet, account.id().toString(), 2_000n);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await client.syncChain();
      const notes = await client.notes.listAvailable({ account: account.id().toString() });
      if (notes.length === 0) break;
      await client.transactions.consume({
        account: account.id().toString(),
        notes: notes.map((note) => note.id().toString()),
        waitForConfirmation: true,
      });
    }
    const held = await freshBalance(client, account.id(), feeFaucet);
    observe("7.0", "tester created and funded", `${account.id().toString()} · ${money(held)}`);
    tester = account;
  } else {
    tester = codes[0] ? await makeTester(codes[0], "tester") : null;
  }
  if (!tester) {
    note("no tester code or --tester account: the refused-operation checks did not run");
  } else {
    // The tester pays its own transaction fees, so it needs funds before it can
    // be refused by anything.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await client.syncChain();
      const notes = await client.notes.listAvailable({ account: tester.id().toString() });
      if (notes.length === 0) break;
      await client.transactions.consume({
        account: tester.id().toString(),
        notes: notes.map((note) => note.id().toString()),
        waitForConfirmation: true,
      });
    }
    let testerHeld = await freshBalance(client, tester.id(), feeFaucet);
    if (testerHeld < 500n) {
      await fund(client, operator, feeFaucet, tester.id().toString(), 500n);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await client.syncChain();
        const notes = await client.notes.listAvailable({ account: tester.id().toString() });
        if (notes.length === 0) break;
        await client.transactions.consume({
          account: tester.id().toString(),
          notes: notes.map((note) => note.id().toString()),
          waitForConfirmation: true,
        });
      }
      testerHeld = await freshBalance(client, tester.id(), feeFaucet);
    }
    observe("7.0b", "tester funded", money(testerHeld));
    // 7.1 A config note from an account that is not the registry's admin must
    // leave the fee alone. It needs a registry, so it is skipped when phase 1
    // did not run.
    if (!chain.registryId) {
      note("no preflight registry in this run: 7.1 and 7.2 did not run");
    } else {
    const feeBefore = await readRegistryRegisterFee(getAccount, chain.registryId);
    const attempt = buildRegistryConfigNote({
      sender: tester.id(),
      registryId: chain.registryId,
      registerFee: feeBefore + 1n,
    });
    const request = await outputNotesRequest(client, [attempt], chain.registryId);
    const { txId } = await client.transactions.submit(tester.id(), request);
    await client.transactions.waitFor(txId);
    await sleep(20_000);
    await client.syncChain();
    const feeAfter = await readRegistryRegisterFee(getAccount, chain.registryId);
    check("7.1", "non-admin fee change refused", money(feeAfter), money(feeBefore));

    // 7.2 A launch note from an account that is not the faucet's owner must not
    // mint. The faucet is fresh, so the only thing that can stop it is the owner
    // check.
    const victim = await createNetworkFaucet(client, {
      name: "port0 preflight gate",
      symbol: "PGTE",
      decimals: 0,
      maxSupply: 1_000n,
      owner: operator.id(),
      feeFaucetId: feeFaucet,
    });
    const victimId = victim.id();
    await fund(client, operator, feeFaucet, victimId.toString(), 112n);
    const fundingNote = await waitForNote(client, victimId.toString());
    await deployNetworkFaucet(client, victimId, fundingNote, { waitForConfirmation: true });

    const stolen = buildLaunchNote({ sender: tester.id(), faucetId: victimId, recipient: tester.id() });
    const stealRequest = await outputNotesRequest(client, [stolen], victimId);
    const { txId: stealTx } = await client.transactions.submit(tester.id(), stealRequest);
    await client.transactions.waitFor(stealTx);
    await sleep(20_000);
    await client.syncChain();
    const victimAccount = await client.accounts.get(victimId.toString());
    const supply = BigInt(BasicFungibleFaucetComponent.fromAccount(victimAccount).maxSupply().asInt());
    const held = await client.accounts.getBalance(tester.id(), victimId);
    check("7.2", "non-owner launch minted nothing", `${held} to the tester`, "0 to the tester");
    observe("7.2b", "faucet supply is the configured max", supply.toString());
    }
  }

  const spent = before - (await balanceOf(client, operator.id(), feeFaucet));
  observe("7.4", "spent", money(spent));
}

/* Main -------------------------------------------------------------------- */



const operatorRef = process.env.PORT0_OPERATOR;
if (!operatorRef) {
  console.error("PORT0_OPERATOR is required: the operator is the only account the run reuses.");
  process.exit(2);
}

console.log(`port0 preflight · ${chainName}`);
console.log(line("═"));
console.log(`  chain      ${chainName}`);
console.log(`  rpc        ${CHAIN.rpcUrl}`);
console.log(`  store      ${CHAIN.store}`);
console.log(`  registry   ${CHAIN.productionRegistry}  (read only)`);
console.log(`  phases     ${phases.join(", ")}`);
console.log(`  cost       ${money(phases.reduce((sum, n) => sum + PHASE_COST[n], 0))}`);

const client = await MidenClient.create({
  rpcUrl: CHAIN.rpcUrl,
  feeFaucetId: CHAIN.feeFaucetId,
  proverUrl: CHAIN.proverUrl,
  noteTransportUrl: CHAIN.noteTransportUrl,
  autoSync: true,
  storeName: CHAIN.store,
});

const operatorId = AccountId.fromHex(operatorRef.startsWith("0x") ? operatorRef : `0x${operatorRef}`);
const feeFaucet = AccountId.fromHex(CHAIN.feeFaucetId);

let operatorAccount = null;
try {
  operatorAccount = await client.accounts.get(operatorId.toString());
} catch {
  operatorAccount = null;
}
if (!operatorAccount) {
  section("Operator");
  fail("operator in store", "no");
  note(`The store ${CHAIN.store} holds no keyed account for ${operatorId.toString()}.`);
  note("Either import one with --key <path>, or create one with --new-operator (which");
  note("needs an invitation code on a gated chain), then run again. Nothing was done.");
  process.exit(1);
}

/** The stored account, which signs everything; `operatorId` names it. */
const operator = operatorAccount;

// Money sent to the operator arrives as notes. Consume them before reading the
// balance, or a funded wallet looks empty.
for (let attempt = 0; attempt < 20; attempt += 1) {
  await client.syncChain();
  const notes = await client.notes.listAvailable({ account: operatorId.toString() });
  if (notes.length === 0) break;
  await client.transactions.consume({
    account: operatorId.toString(),
    notes: notes.map((note) => note.id().toString()),
    waitForConfirmation: true,
  });
}
// Read the balance from the store after the drain: the account object above was
// fetched before it, so its vault is a snapshot.
const current = await client.accounts.get(operatorId.toString());
const balanceBefore = current.vault().getBalance(feeFaucet);
observe("balance", "operator balance", money(balanceBefore));

const planned = phases.reduce((sum, n) => sum + PHASE_COST[n], 0);
if (spending && balanceBefore < BigInt(planned)) {
  section("Funding");
  fail("balance covers the run", "no");
  console.log(`\n  Send at least ${money(BigInt(planned) - balanceBefore)} to:\n`);
  console.log(`    ${bech32(operatorId)}\n`);
  console.log(`  ${operatorId.toString()}\n`);
  note("The operator pays for every transaction the run makes. Nothing was done.");
  process.exit(1);
}

const startedAt = Date.now();
const results = {};
const chain = {};
let built = null;

if (phases.includes(0)) {
  built = await phase0(client, operator, feeFaucet);
}
// Phases 1 to 6 need the reference values from phase 0; phase 7 does not.
if (phases.some((n) => n >= 1 && n <= 6)) {
  if (!built) {
    section("Reference build");
    note("The spending phases need the build's commitment and auth roots.");
    note("Run phase 0 in the same invocation, for example --phase 0,1.");
    process.exit(2);
  }
  const spentBefore = await balanceOf(client, operator.id(), feeFaucet);
  if (phases.includes(1)) {
    Object.assign(chain, await phase1(client, operator, feeFaucet, {
      commitment: built.commitment,
      authRoots: built.authRoots,
    }));
  }
  if (phases.includes(2) && chain.registryId) {
    await phase2(client, operator, feeFaucet, chain.registryId);
  }
  if (phases.includes(3)) {
    Object.assign(chain, await phase3(client, operator, feeFaucet));
  }
  if (phases.includes(4) && chain.registryId && chain.faucetId) {
    Object.assign(chain, await phase4(client, operator, feeFaucet, chain.registryId, {
      faucetId: chain.faucetId,
      symbol: chain.symbol,
      maxSupply: chain.maxSupply,
    }));
  }
  if (phases.includes(5) && chain.poolId) {
    await phase5(client, operator, feeFaucet, {
      poolId: chain.poolId,
      config: chain.config,
      token0: chain.token0,
    });
  }
  if (phases.includes(6) && chain.registryId && chain.poolId) {
    await phase6(client, operator, feeFaucet, chain.registryId, {
      poolId: chain.poolId,
      config: chain.config,
    });
  }
  const spentTotal = spentBefore - (await balanceOf(client, operator.id(), feeFaucet));
  results.spend = spentTotal.toString();
}

// Phase 7 runs whenever it is selected: with phases 1 to 6 it uses the registry
// they created, and on its own it runs the checks that need no registry.
if (phases.includes(7)) {
  const spentBefore7 = await balanceOf(client, operator.id(), feeFaucet);
  await phase7(client, operator, feeFaucet, { registryId: chain.registryId }, codes);
  const spent7 = spentBefore7 - (await balanceOf(client, operator.id(), feeFaucet));
  results.spend = (BigInt(results.spend ?? "0") + spent7).toString();
}

const balanceAfter = (await client.accounts.get(operatorId.toString())).vault().getBalance(feeFaucet);
const spent = balanceBefore - balanceAfter;

section("Result");
console.log(`  ${failures === 0 ? "✓ all checks passed" : `✗ ${failures} check(s) failed`}`);
console.log(`  ${"spent on fees".padEnd(30)} ${money(spent)}`);
console.log(`  ${"elapsed".padEnd(30)} ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);

const report = {
  chain: chainName,
  operator: { hex: operatorId.toString(), bech32: bech32(operatorId) },
  phases,
  startedAt: new Date(startedAt).toISOString(),
  balanceBefore: balanceBefore.toString(),
  balanceAfter: balanceAfter.toString(),
  spent: spent.toString(),
  failures,
  checks: record,
};
const reportPath = value("--report");
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`  ${"report".padEnd(30)} ${reportPath}`);
}

process.exit(failures === 0 ? 0 : 1);
