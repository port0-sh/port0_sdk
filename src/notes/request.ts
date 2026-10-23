/**
 * Transaction-request helpers for emitting one or more own output notes from a
 * sender account.
 */
import {
  Note,
  TransactionRequest,
  type AccountId,
  type MidenClient,
} from "@miden-sdk/miden-sdk";
import { wasmModule } from "../wasm.js";

/**
 * Emits `notes` as own output notes of one request the wallet signs.
 *
 * The wallet account is private, so its three-word `MultisigAuthArgs` preimage
 * cannot be built by `feeAwareTransactionRequestBuilder`; it is declared here as
 * `[bound_block, 0, 0, 0] || SALT || CONVERSION_INFO` with the Poseidon2
 * commitment as the auth argument. The target is declared as a foreign account
 * because the kernel calls `estimate_note_fee` on it to price the emitted note.
 */
export async function ownOutputNotesRequest(
  client: MidenClient,
  notes: Note[],
  targetPoolId: AccountId,
): Promise<TransactionRequest> {
  const {
    AccountStorageRequirements,
    AdviceMap,
    Felt,
    FeltArray,
    ForeignAccount,
    ForeignAccountArray,
    NoteArray,
    Poseidon2,
    TransactionRequestBuilder,
  } = wasmModule();

  const outputs = new NoteArray();
  for (const note of notes) {
    outputs.push(note);
  }

  // Fresh random salt (replay guard), four canonical field elements.
  const saltBuf = new BigUint64Array(4);
  crypto.getRandomValues(saltBuf);
  const salt: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    salt.push((saltBuf[i] ?? 0n) & 0x3fffffffffffffffn);
  }

  const boundBlock = await client.getSyncHeight();
  const feeFaucetId = await client.feeFaucetId();
  const conversionInfo = [
    feeFaucetId.suffix().asInt(),
    feeFaucetId.prefix().asInt(),
    1n,
    1n,
  ];

  // [bound_block, approval_expiration(0), 0, 0] || SALT || CONVERSION_INFO.
  const elements = [BigInt(boundBlock), 0n, 0n, 0n, ...salt, ...conversionInfo];
  const toFelts = (values: bigint[]) =>
    new FeltArray(values.map((value) => new Felt(value)));

  const commitment = Poseidon2.hashElements(toFelts(elements));

  const adviceMap = new AdviceMap();
  adviceMap.insert(commitment, toFelts(elements));

  const targets = new ForeignAccountArray();
  targets.push(
    ForeignAccount.public(targetPoolId, new AccountStorageRequirements()),
  );

  return new TransactionRequestBuilder()
    .withOwnOutputNotes(outputs)
    .withForeignAccounts(targets)
    .withAuthArg(commitment)
    .withBlockNumbers([boundBlock])
    .extendAdviceMap(adviceMap)
    .build();
}

/**
 * Emits `notes` as own output notes of one request the client signs.
 *
 * Declares neither auth args nor block numbers: the client attaches its signature
 * and the conversion info it fetched itself, and declaring the multisig preimage
 * as well puts two conversion infos in play, which the kernel rejects. The target
 * is declared as a foreign account for note-fee estimation.
 */
export async function outputNotesRequest(
  client: MidenClient,
  notes: Note[],
  targetAccountId: AccountId,
): Promise<TransactionRequest> {
  const {
    AccountStorageRequirements,
    ForeignAccount,
    ForeignAccountArray,
    NoteArray,
    TransactionRequestBuilder,
  } = wasmModule();

  const outputs = new NoteArray();
  for (const note of notes) {
    outputs.push(note);
  }

  const targets = new ForeignAccountArray();
  targets.push(
    ForeignAccount.public(targetAccountId, new AccountStorageRequirements()),
  );

  return new TransactionRequestBuilder()
    .withOwnOutputNotes(outputs)
    .withForeignAccounts(targets)
    .build();
}
