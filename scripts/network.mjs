/**
 * Environment handling shared by the tooling: which chain is in use, and which
 * client store that chain may use.
 *
 * The chain is identified by its fee faucet, which the client reports after its
 * first sync. That is the same value the deploy verifies against
 * `PORT0_FEE_FAUCET_ID`, so one check ties the configured environment to the node
 * the client is actually talking to.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Chains the tooling knows, keyed by their fee faucet. */
const CHAINS = {
  "0x4cbdcaffe75f0a317482224dae6436": { name: "testnet", bech32: "testnet" },
  "0xe69e6ca6e39df1b10c1e5399399feb": { name: "mainnet", bech32: "mainnet" },
};

/**
 * Loads the environment file.
 *
 * `PORT0_ENV_FILE` selects a file other than `.env`, so one checkout can hold
 * `.env.testnet` and `.env.mainnet` and a run names the one it means.
 */
export function loadEnvironment() {
  const named = process.env.PORT0_ENV_FILE;
  const file = named ?? ".env";
  if (existsSync(file)) {
    process.loadEnvFile(file);
    return;
  }
  // A named file that is absent would leave every variable unset and surface as
  // an unrelated "is required" error.
  if (named) {
    throw new Error(`PORT0_ENV_FILE is ${named}, which does not exist`);
  }
}

/**
 * The chain behind `feeFaucetId`, as `{ name, bech32 }`. Unknown faucets resolve
 * to the value of `PORT0_NETWORK`, defaulting to testnet, because a development
 * node has its own.
 */
export function chainOf(feeFaucetId) {
  const known = CHAINS[feeFaucetId.toLowerCase()];
  if (known) return known;
  const name = (process.env.PORT0_NETWORK ?? "testnet").trim().toLowerCase();
  return { name, bech32: name };
}

/** The store directory, under `~/.miden/stores/`. */
function storePath(storeName) {
  return join(homedir(), ".miden", "stores", storeName);
}

/**
 * Refuses a store already stamped for another chain.
 *
 * One store holds one client database; the same account id can exist on two
 * chains with different state, so a store shared between networks cannot say
 * which chain an account belongs to and the pool and registry lookups then mix
 * them. The stamp is written on first use and checked on every later run.
 */
export function assertStoreChain(storeName, chainName) {
  const dir = storePath(storeName);
  const stamp = join(dir, ".port0-chain");
  if (existsSync(stamp)) {
    const found = readFileSync(stamp, "utf8").trim();
    if (found !== chainName) {
      throw new Error(
        `store ${storeName} belongs to ${found}, this run targets ${chainName}. ` +
          "Use one store per chain, for example PORT0_STORE=port0-" +
          chainName +
          ".",
      );
    }
    return;
  }
  try {
    writeFileSync(stamp, chainName + "\n");
  } catch {
    // A store directory that does not exist yet is created by the client; the
    // stamp is best-effort and the check above still protects later runs.
  }
}
