/**
 * FEE_SPONSORSHIP note builder.
 *
 * Under the network-account fee model the XYK feature note stays fee-unaware;
 * the fee travels in a separate note carrying exactly one fungible asset (the
 * fee, denominated in the pool's fee faucet asset) and the feature note's id in
 * its storage. The two notes are consumed together by the network transaction
 * builder.
 *
 * The sponsorship note is a plain Public note tagged for the pool: it carries
 * no `NetworkAccountTarget` attachment (unlike the feature note).
 */
import {
  AccountId,
  Felt,
  FungibleAsset,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
} from "@miden-sdk/miden-sdk";
import type { AccountIdLike, Word4 } from "../math/encoding.js";
import { wasmModule } from "../wasm.js";
import { word4FromWord } from "./word.js";
import { asAccountId } from "../utils/accountId.js";

/** The 7-felt FEE_SPONSORSHIP storage layout. */
export interface FeeSponsorshipStorageParams {
  /** The bound feature note's id word (four felts, in word order). */
  featureNoteId: Word4;
  /** Account allowed to reclaim the fee after `reclaimHeight`. */
  reclaimer: AccountIdLike;
  /** Block height at/after which reclaim is allowed; 0 disables reclaim. */
  reclaimHeight: bigint;
}

/**
 * Encodes FEE_SPONSORSHIP note storage.
 *
 * Order matches `FeeSponsorshipNoteStorage`: feature note id word, then the
 * reclaimer as `[suffix, prefix]` (not the XYK `[prefix, suffix]` order), then
 * the reclaim height.
 */
export function feeSponsorshipStorage(
  params: FeeSponsorshipStorageParams,
): bigint[] {
  return [
    ...params.featureNoteId,
    params.reclaimer.suffix().asInt(),
    params.reclaimer.prefix().asInt(),
    params.reclaimHeight,
  ];
}

/** The feature note id as four felts, taken from the note's commitment. */
export function featureNoteIdWord(note: Note): Word4 {
  return word4FromWord(note.commitment());
}

export interface FeeSponsorshipNoteInput {
  /** Sponsor account executing the transaction that emits the fee note. */
  sender: AccountId;
  /** The pool (network account) the feature note targets. */
  target: AccountId;
  /** The feature note this sponsorship pays for. */
  featureNote: Note;
  /** Faucet whose asset denominates the fee; hex or bech32 is accepted. */
  feeFaucetId: AccountId | string;
  /** Fee amount, in the fee faucet asset's smallest unit. */
  feeAmount: bigint;
  /** Reclaimer; defaults to `sender`. */
  reclaimer?: AccountId;
  /** Reclaim block height; defaults to 0 (disabled). */
  reclaimHeight?: bigint;
}

/** Builds the FEE_SPONSORSHIP note bound to `featureNote`. */
export function buildFeeSponsorshipNote(input: FeeSponsorshipNoteInput): Note {
  const reclaimer = input.reclaimer ?? input.sender;
  const storage = feeSponsorshipStorage({
    featureNoteId: featureNoteIdWord(input.featureNote),
    reclaimer,
    reclaimHeight: input.reclaimHeight ?? 0n,
  });

  const assets = new NoteAssets([
    new FungibleAsset(asAccountId(input.feeFaucetId), input.feeAmount),
  ]);
  const metadata = new NoteMetadata(
    input.sender,
    NoteType.Public,
    NoteTag.withAccountTarget(input.target),
  );
  const { FeltArray } = wasmModule();
  const recipient = NoteRecipient.fromScript(
    NoteScript.feeSponsorship(),
    new NoteStorage(new FeltArray(storage.map((value) => new Felt(value)))),
  );

  return new Note(assets, metadata, recipient);
}
