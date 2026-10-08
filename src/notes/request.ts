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
 * Wraps `notes` as own output notes of a single transaction request.
 *
 * Used to emit a feature note together with its FEE_SPONSORSHIP note in one
 * transaction. The notes are pushed (not constructor-consumed) so the caller
 * keeps valid references to them after the request is built.
 *
 * 0.17 requirements this satisfies:
 * - Every multisig flavour (the Bread wallet is a Guarded Multisig) reads a
 *   three-word `MultisigAuthArgs` preimage from the advice map:
 *   `[bound_block, 0, 0, 0] || SALT || CONVERSION_INFO`. The wallet account is
 *   private and not in the app's client store, so `feeAwareTransactionRequestBuilder`
 *   cannot build it; the commitment (Poseidon2 hash of the 12 felts) and its
 *   preimage are declared here manually.
 * - The kernel prices the emitted network note by calling `estimate_note_fee`
 *   on the target pool, so the pool is declared as a foreign account (empty
 *   storage requirements; the client resolves a public target lazily).
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
