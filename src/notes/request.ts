/**
 * Transaction-request helpers for emitting one or more own output notes from a
 * sender account.
 */
import {
  Note,
  TransactionRequest,
  TransactionRequestBuilder,
} from "@miden-sdk/miden-sdk";
import { wasmModule } from "../wasm.js";

/**
 * Wraps `notes` as own output notes of a single transaction request.
 *
 * Used to emit a feature note together with its FEE_SPONSORSHIP note in one
 * transaction. The notes are pushed (not constructor-consumed) so the caller
 * keeps valid references to them after the request is built.
 */
export function ownOutputNotesRequest(notes: Note[]): TransactionRequest {
  const { NoteArray } = wasmModule();
  const outputs = new NoteArray();
  for (const note of notes) {
    outputs.push(note);
  }
  return new TransactionRequestBuilder().withOwnOutputNotes(outputs).build();
}
