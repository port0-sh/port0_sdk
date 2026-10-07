/**
 * Pure felt layouts for the five XYK note scripts.
 *
 * Each note script asserts a fixed storage length and reads fields in the
 * exact order below. Account ids are `[prefix, suffix]`; a serial number is
 * four felts. These functions are WASM-free so they can be unit-tested
 * directly against the contract's asserted lengths and field order.
 */
import {
  accountIdFelts,
  type AccountIdLike,
  type SerialNumber,
  type Word4,
} from "../math/encoding.js";

/** Storage shared by mint, burn, and swap: pool, recipient, serial, tag, deadline. */
export interface PoolNoteCommon {
  poolId: AccountIdLike;
  recipient: AccountIdLike;
  serial: SerialNumber;
  tag: bigint;
  deadline: bigint;
}

function poolNotePrefix(params: PoolNoteCommon): bigint[] {
  return [
    ...accountIdFelts(params.poolId),
    ...accountIdFelts(params.recipient),
    ...params.serial,
    params.tag,
    params.deadline,
  ];
}

/** mint-note: 11 felts. Assets: token0 and token1. */
export function mintNoteStorage(
  params: PoolNoteCommon & { minLpOut: bigint },
): bigint[] {
  return [...poolNotePrefix(params), params.minLpOut];
}

/** burn-note: 12 felts. Asset: the LP token. */
export function burnNoteStorage(
  params: PoolNoteCommon & { minAmount0: bigint; minAmount1: bigint },
): bigint[] {
  return [
    ...poolNotePrefix(params),
    params.minAmount0,
    params.minAmount1,
  ];
}

/** swap-note: 11 felts. Asset: token0 or token1. */
export function swapNoteStorage(
  params: PoolNoteCommon & { minAmountOut: bigint },
): bigint[] {
  return [...poolNotePrefix(params), params.minAmountOut];
}

/** collect-note: 4 felts. No assets. */
export function collectNoteStorage(serial: SerialNumber): bigint[] {
  return [...serial];
}

/** admin-note: 14 felts. No assets. */
export interface AdminNoteParams {
  poolId: AccountIdLike;
  feeTo: AccountIdLike;
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  p2idRoot: Word4;
  lpKey: Word4;
}

export function adminNoteStorage(params: AdminNoteParams): bigint[] {
  return [
    ...accountIdFelts(params.poolId),
    ...accountIdFelts(params.feeTo),
    params.lpFeeBps,
    params.protocolFeeBps,
    ...params.p2idRoot,
    ...params.lpKey,
  ];
}
