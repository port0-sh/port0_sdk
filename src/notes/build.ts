/**
 * Builders that turn XYK parameters into ready-to-emit network notes.
 *
 * Every builder produces a Public note carrying a `NetworkAccountTarget`
 * attachment bound to the pool, the compiled XYK note script, the exact felt
 * storage layout the script asserts, and the assets the script consumes.
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
  NetworkAccountTarget,
  Word,
} from "@miden-sdk/miden-sdk";
import {
  accountTargetTag,
  fungibleAssetIdWord,
  randomSerial,
  type SerialNumber,
  type Word4,
} from "../math/encoding.js";
import { wasmModule } from "../wasm.js";
import {
  registryCollectNoteStorage,
  burnNoteStorage,
  collectNoteStorage,
  mintNoteStorage,
  registerNoteStorage,
  swapNoteStorage,
} from "./layouts.js";
import { noteScript } from "./scripts.js";
import { word4FromWord } from "./word.js";

function buildNetworkNote(input: {
  sender: AccountId;
  target: AccountId;
  script: NoteScript;
  inputs: bigint[];
  assets: { token: AccountId; amount: bigint }[];
}): Note {
  const { FeltArray, NoteExecutionHint } = wasmModule();
  const noteAssets = new NoteAssets(
    input.assets.map((asset) => new FungibleAsset(asset.token, asset.amount)),
  );
  const metadata = new NoteMetadata(
    input.sender,
    NoteType.Public,
    NoteTag.withAccountTarget(input.target),
  );
  const recipient = NoteRecipient.fromScript(
    input.script,
    new NoteStorage(
      new FeltArray(input.inputs.map((value) => new Felt(value))),
    ),
  );
  // The execution hint must be explicit. A target built without one emits
  // `NoteExecutionHint::None`, which tells the node not to schedule the note,
  // and the note is never consumed. `Always` is the hint the canonical network
  // note carries, and the one the pool's and registry's notes require.
  const target = new NetworkAccountTarget(
    input.target,
    NoteExecutionHint.always(),
  );
  return Note.withAttachments(noteAssets, metadata, recipient, [
    target.toAttachment(),
  ]);
}

/** The standard P2ID script root, used for the pool's output notes. */
export function p2idRoot(): Word4 {
  return word4FromWord(NoteScript.p2id().root());
}

export interface MintNoteInput {
  /** Account executing the transaction that emits the note. */
  sender: AccountId;
  /** Pool (network account) the note targets. */
  poolId: AccountId;
  /** Recipient of the minted LP tokens. */
  recipient: AccountId;
  /** Faucet issuing token0. */
  token0: AccountId;
  /** Faucet issuing token1. */
  token1: AccountId;
  amount0: bigint;
  amount1: bigint;
  minLpOut: bigint;
  /** Block timestamp after which the pool reverts the note. */
  deadline: bigint;
  /** Output-note serial; defaults to a fresh random serial. */
  serial?: SerialNumber;
  /** Output-note tag; defaults to the recipient's account target tag. */
  tag?: bigint;
}

export function buildMintNote(input: MintNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.poolId,
    script: noteScript("mint"),
    inputs: mintNoteStorage({
      poolId: input.poolId,
      recipient: input.recipient,
      serial: input.serial ?? randomSerial(),
      tag: input.tag ?? accountTargetTag(input.recipient),
      deadline: input.deadline,
      minLpOut: input.minLpOut,
    }),
    assets: [
      { token: input.token0, amount: input.amount0 },
      { token: input.token1, amount: input.amount1 },
    ],
  });
}

export interface BurnNoteInput {
  sender: AccountId;
  poolId: AccountId;
  /** Recipient of the returned token0 and token1. */
  recipient: AccountId;
  /** LP tokens to burn; the pool id is the LP faucet. */
  amountLp: bigint;
  minAmount0: bigint;
  minAmount1: bigint;
  deadline: bigint;
  serial?: SerialNumber;
  tag?: bigint;
}

export function buildBurnNote(input: BurnNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.poolId,
    script: noteScript("burn"),
    inputs: burnNoteStorage({
      poolId: input.poolId,
      recipient: input.recipient,
      serial: input.serial ?? randomSerial(),
      tag: input.tag ?? accountTargetTag(input.recipient),
      deadline: input.deadline,
      minAmount0: input.minAmount0,
      minAmount1: input.minAmount1,
    }),
    assets: [{ token: input.poolId, amount: input.amountLp }],
  });
}

export interface SwapNoteInput {
  sender: AccountId;
  poolId: AccountId;
  /** Recipient of the swapped-out token. */
  recipient: AccountId;
  /** Faucet of the token being swapped in. */
  tokenIn: AccountId;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  serial?: SerialNumber;
  tag?: bigint;
}

export function buildSwapNote(input: SwapNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.poolId,
    script: noteScript("swap"),
    inputs: swapNoteStorage({
      poolId: input.poolId,
      recipient: input.recipient,
      serial: input.serial ?? randomSerial(),
      tag: input.tag ?? accountTargetTag(input.recipient),
      deadline: input.deadline,
      minAmountOut: input.minAmountOut,
    }),
    assets: [{ token: input.tokenIn, amount: input.amountIn }],
  });
}

export interface CollectNoteInput {
  /** The fee recipient account sending the note. */
  sender: AccountId;
  poolId: AccountId;
  serial?: SerialNumber;
}

export function buildCollectNote(input: CollectNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.poolId,
    script: noteScript("collect"),
    inputs: collectNoteStorage(input.serial ?? randomSerial()),
    assets: [],
  });
}

export interface RegistryCollectNoteInput {
  /** Account executing the transaction that emits the note. */
  sender: AccountId;
  registryId: AccountId;
  /** Asset key of the fee asset to sweep. */
  assetKey: Word4;
  /** Optional note serial; defaults to a fresh random one. */
  serial?: Word4;
}

/**
 * Builds the note that makes the registry pay out its accumulated register fees.
 *
 * Collection is permissionless: the destination is the registry's protocol
 * account, so any sender can trigger it and none can redirect it.
 */
export function buildRegistryCollectNote(input: RegistryCollectNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.registryId,
    script: noteScript("registry-collect"),
    inputs: registryCollectNoteStorage({
      registryId: input.registryId,
      assetKey: input.assetKey,
      serial: input.serial ?? randomSerial(),
    }),
    assets: [],
  });
}

export interface RegisterNoteInput {
  /** Account executing the transaction that emits the register note. */
  sender: AccountId;
  /** Registry (network account) the note targets. */
  registryId: AccountId;
  /** Pool being registered. */
  poolId: AccountId;
  /** First token of the ordered pair. */
  asset0: AccountId;
  /** Second token of the ordered pair. */
  asset1: AccountId;
}

export function buildRegisterNote(input: RegisterNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.registryId,
    script: noteScript("register"),
    inputs: registerNoteStorage({
      registryId: input.registryId,
      poolId: input.poolId,
      asset0: input.asset0,
      asset1: input.asset1,
    }),
    assets: [],
  });
}
