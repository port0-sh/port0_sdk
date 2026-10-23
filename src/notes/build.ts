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
  /**
   * Asset keys to sweep. The pool pays everything it holds above its stored
   * reserves for each key: the protocol pot for token0/token1, the whole
   * balance for any other asset. Include token0 and token1 to collect fees.
   */
  assetKeys: readonly Word4[];
  serial?: SerialNumber;
}

export function buildCollectNote(input: CollectNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.poolId,
    script: noteScript("collect"),
    inputs: collectNoteStorage({
      poolId: input.poolId,
      serial: input.serial ?? randomSerial(),
      assetKeys: input.assetKeys,
    }),
    assets: [],
  });
}

export interface RegistryCollectNoteInput {
  /** Account executing the transaction that emits the note. */
  sender: AccountId;
  registryId: AccountId;
  /** Asset keys to sweep; the registry pays its whole balance of each. */
  assetKeys: readonly Word4[];
  /** Optional note serial; defaults to a fresh random one. */
  serial?: Word4;
}

/**
 * Builds the note that makes the registry pay out its accumulated balance.
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
      serial: input.serial ?? randomSerial(),
      assetKeys: input.assetKeys,
    }),
    assets: [],
  });
}

export interface LaunchNoteInput {
  /** Owner of the faucet: the only account whose note can launch it. */
  sender: AccountId;
  /** Network faucet the note targets. */
  faucetId: AccountId;
  /** Account that receives the whole supply. */
  recipient: AccountId;
  /** Output-note serial number; defaults to a random one. */
  serial?: [bigint, bigint, bigint, bigint];
  /** Output-note tag; defaults to the recipient's account target. */
  tag?: bigint;
}

/**
 * Builds the note that launches a network faucet: it mints the whole maximum
 * supply and pays it to `recipient`, once. The faucet checks the note's sender
 * against its owner, so a launch note from anybody else aborts.
 */
export function buildLaunchNote(input: LaunchNoteInput): Note {
  return buildNetworkNote({
    sender: input.sender,
    target: input.faucetId,
    script: noteScript("launch"),
    inputs: [
      input.faucetId.prefix().asInt(),
      input.faucetId.suffix().asInt(),
      input.recipient.prefix().asInt(),
      input.recipient.suffix().asInt(),
      ...(input.serial ?? serialInputs()),
      input.tag ?? accountTargetTag(input.recipient),
    ],
    assets: [],
  });
}

/** Four random felts for an output note serial number. */
function serialInputs(): [bigint, bigint, bigint, bigint] {
  const serial = randomSerial();
  return [serial[0], serial[1], serial[2], serial[3]];
}

export interface RegistryConfigNoteInput {
  /** Account executing the transaction that emits the config note: the admin. */
  sender: AccountId;
  /** Registry (network account) the note targets. */
  registryId: AccountId;
  /** New register fee, in the fee asset's base units. */
  registerFee: bigint;
}

/**
 * Builds the note that sets the registry's register fee.
 *
 * The registry checks the note's sender against the admin it was created with,
 * so a config note from anybody else is rejected. The fee is what registration
 * costs, so changing it is the only lever against a flood of pools. The note
 * carries the register note's script root, which the registry requires to be
 * already scheduled: the root moves whenever the registry's interface changes,
 * so it cannot be a constant in the registry.
 */
export function buildRegistryConfigNote(input: RegistryConfigNoteInput): Note {
  const root = noteScript("register").root().toU64s();
  return buildNetworkNote({
    sender: input.sender,
    target: input.registryId,
    script: noteScript("registry-config"),
    inputs: [
      input.registryId.prefix().asInt(),
      input.registryId.suffix().asInt(),
      input.registerFee,
      BigInt(root[0] ?? 0n),
      BigInt(root[1] ?? 0n),
      BigInt(root[2] ?? 0n),
      BigInt(root[3] ?? 0n),
    ],
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
