/**
 * Network faucet: a fixed-supply token whose faucet is a network account.
 *
 * A regular faucet is a keyed account, so on a network that gates keyed accounts
 * its first transaction needs an invitation code. A network account is exempt,
 * which is what makes launching a token free of that requirement.
 *
 * The account carries the standard basic fungible faucet component, which is what
 * makes a wallet recognize it as a faucet and read its name, symbol, and
 * decimals, plus the `network-faucet` component, which owns the launch and the
 * supply accounting, plus the network auth that allowlists the launch note.
 *
 * The launch is one-way and total: it mints the whole maximum supply once and
 * pays it to a recipient. There is no second mint, by construction.
 */
import {
  Account,
  AccountBuilder,
  AccountComponent,
  AccountId,
  AccountStorageMode,
  NoteScriptFee,
  Package,
  StorageSlot,
  type MidenClient,
  type TransactionSubmitResult,
} from "@miden-sdk/miden-sdk";
import { contractPackageBytes } from "../artifacts.js";
import { NOTE_FEES } from "../constants.js";
import { noteScript } from "../notes/scripts.js";
import { asAccountId } from "../utils/accountId.js";
import { standardFaucetComponent } from "./lpFaucet.js";
import { wordFromWord4 } from "../notes/word.js";
import { randomSeed } from "../math/encoding.js";
import { wasmModule } from "../wasm.js";

/** Launch note fee, from the schedule; the owner pays it through a sponsorship. */
export const LAUNCH_FEE = NOTE_FEES.launch;

export interface CreateNetworkFaucetParams {
  /** Token display name, UTF-8 up to 32 bytes. */
  name: string;
  /** Token symbol, 1 to 12 uppercase ASCII letters. */
  symbol: string;
  /** Token decimals, 0 to 12. */
  decimals: number;
  /** Whole supply, minted once at launch. */
  maxSupply: bigint;
  /** Account allowed to launch the token, immutable. */
  owner: AccountId;
  /** Faucet whose asset denominates network note fees. */
  feeFaucetId: AccountId | string;
  /** 32-byte account seed; defaults to a fresh random seed. */
  seed?: Uint8Array;
}

/**
 * Builds the network faucet account without inserting it into the client store.
 *
 * The standard fungible faucet component supplies the metadata and the wallet
 * recognition; the network-faucet component holds the owner and the launch flag,
 * and pays the supply out with the standard P2ID script.
 */
export async function buildNetworkFaucet(
  client: MidenClient,
  params: CreateNetworkFaucetParams,
): Promise<Account> {
  const { StorageSlotArray, StorageSlot: Slot } = wasmModule();
  const owner = asAccountId(params.owner);

  // Our component's own slots: the owner and the launch flag.
  const slots = new StorageSlotArray([
    Slot.fromValue(
      "network_faucet::network_faucet::owner",
      wordFromWord4([0n, 0n, owner.suffix().asInt(), owner.prefix().asInt()]),
    ),
    Slot.fromValue("network_faucet::network_faucet::launched", wordFromWord4([0n, 0n, 0n, 0n])),
  ]);
  const faucetComponent = AccountComponent.fromPackage(
    Package.deserialize(contractPackageBytes("network-faucet")),
    slots,
  );

  // The standard faucet component: name, symbol, decimals, and the maximum
  // supply the launch mints. Its own minting procedure stays unreachable because
  // the account installs no mint policy and that procedure aborts without one.
  const standard = await standardFaucetComponent(client, {
    name: params.name,
    symbol: params.symbol,
    decimals: params.decimals,
    maxSupply: params.maxSupply,
  });

  const feeEntries = [new NoteScriptFee(noteScript("launch").root(), LAUNCH_FEE)];
  const authComponents = AccountComponent.createNetworkAuthComponents(
    feeEntries,
    asAccountId(params.feeFaucetId),
  );

  let builder = new AccountBuilder(params.seed ?? randomSeed())
    .storageMode(AccountStorageMode.public())
    .withComponent(faucetComponent)
    .withComponent(standard);
  for (const component of authComponents) {
    builder = builder.withComponent(component);
  }
  return builder.build().account;
}

/** Inserts the faucet account into the client store; it is deployed by funding. */
export async function createNetworkFaucet(
  client: MidenClient,
  params: CreateNetworkFaucetParams,
): Promise<Account> {
  const account = await buildNetworkFaucet(client, params);
  await client.accounts.insert({ account });
  return account;
}

/**
 * Deploys the faucet by consuming a funding note as its first transaction.
 * A network account's first transaction creates it on chain.
 */
export async function deployNetworkFaucet(
  client: MidenClient,
  faucetId: AccountId,
  fundingNoteId: string,
  options?: { waitForConfirmation?: boolean },
): Promise<TransactionSubmitResult> {
  return client.transactions.consume({
    account: faucetId.toString(),
    notes: [fundingNoteId],
    waitForConfirmation: options?.waitForConfirmation ?? false,
  });
}
