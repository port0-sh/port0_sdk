#!/usr/bin/env node
/**
 * Sets the registry's register fee, the price of listing a pool.
 *
 *   node scripts/set-register-fee.mjs <base-units> [--submit]
 *
 * Dry run by default: it reads the live fee and reports the change. `--submit`
 * emits the registry-config note, which the node consumes on the registry. The
 * registry only accepts that note from the admin it was created with, so the
 * caller account must be that admin.
 *
 * Environment (from the environment or a `.env` file in this directory):
 *   PORT0_REGISTRY_ID    required
 *   MIDEN_RPC_URL        default https://rpc.testnet.miden.io
 *   PORT0_PROVER         default testnet
 *   PORT0_STORE          default port0-registry, must hold the admin's key
 *   PORT0_OPERATOR       optional, admin account id; defaults to the first
 *                        non-network account in the store
 *   PORT0_WAIT_SECS      default 300, how long to wait for the price to change
 */
import { existsSync } from "node:fs";
import { AccountId, MidenClient } from "@miden-sdk/miden-sdk";
import {
  buildRegistryConfigNote,
  outputNotesRequest,
  readRegistryRegisterFee,
} from "../dist/index.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const fee = BigInt(process.argv[2] ?? "");
if (process.argv[2] === undefined || fee <= 0n) {
  throw new Error("usage: set-register-fee.mjs <base-units> [--submit]");
}
const submit = process.argv.includes("--submit");

const registryId = AccountId.fromHex(required("PORT0_REGISTRY_ID"));
const rpcUrl = process.env.MIDEN_RPC_URL ?? "https://rpc.testnet.miden.io";
const storeName = process.env.PORT0_STORE ?? "port0-registry";
const operatorRef = process.env.PORT0_OPERATOR;
const feeFaucetId = AccountId.fromHex(required("PORT0_FEE_FAUCET_ID"));

const client = await MidenClient.create({
  rpcUrl,
  feeFaucetId: feeFaucetId.toString(),
  proverUrl: process.env.PORT0_PROVER ?? "testnet",
  noteTransportUrl: process.env.PORT0_NOTE_TRANSPORT ?? "testnet",
  autoSync: true,
  storeName,
});

await client.syncChain();
const admin = await resolveAdmin();
const getAccount = (id) => client.accounts.get(id);
const before = await readRegistryRegisterFee(getAccount, registryId);

console.log(`registry: ${registryId.toString()}`);
console.log(`admin:    ${admin.id().toString()}`);
console.log(`register fee: ${before} -> ${fee} base units`);
if (before === fee) {
  console.log("nothing to do: the fee is already set to this value");
  await client.terminate();
  process.exit(0);
}

const note = buildRegistryConfigNote({
  sender: admin.id(),
  registryId,
  registerFee: fee,
});
// The config note is priced at zero and the registry pays its own transaction
// fee from the register fees it holds, so no sponsorship is attached: one would
// donate its amount to the registry on every change.
const request = await outputNotesRequest(client, [note], registryId);

if (!submit) {
  console.log("dry run: the note is built and nothing is submitted. Pass --submit to apply.");
  await client.terminate();
  process.exit(0);
}

const { txId } = await client.transactions.submit(admin.id(), request);
console.log(`submitted ${txId.toHex()}; waiting for the registry to consume it`);
await client.transactions.waitFor(txId);

const waitSecs = Number(process.env.PORT0_WAIT_SECS ?? "300");
const deadline = Date.now() + waitSecs * 1000;
for (;;) {
  await client.syncChain();
  const now = await readRegistryRegisterFee(getAccount, registryId);
  if (now === fee) {
    console.log(`register fee is now ${now} base units`);
    break;
  }
  if (Date.now() > deadline) {
    console.log(
      `the network builder has not consumed the note within ${waitSecs}s; ` +
        `the fee is still ${now}. Re-run, or check the registry's allowlist.`,
    );
    process.exitCode = 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

await client.terminate();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The account that emits the config note: the registry's admin. */
async function resolveAdmin() {
  if (operatorRef) {
    const account = await client.accounts.get(AccountId.fromHex(operatorRef));
    if (!account) throw new Error(`admin account ${operatorRef} is not in this store`);
    return account;
  }
  for (const header of await client.accounts.list()) {
    const account = await client.accounts.get(header.id());
    if (account && !account.isNetworkAccount()) return account;
  }
  throw new Error("no admin account in the store; set PORT0_OPERATOR");
}
