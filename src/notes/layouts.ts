/**
 * Pure felt layouts for the XYK note scripts.
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

/** collect-note: `6 + 4n` felts. No assets. */
export interface CollectNoteParams {
  poolId: AccountIdLike;
  serial: SerialNumber;
  /** One asset key per asset the collect sweeps. */
  assetKeys: readonly Word4[];
}

export function collectNoteStorage(params: CollectNoteParams): bigint[] {
  return [
    ...accountIdFelts(params.poolId),
    ...params.serial,
    ...params.assetKeys.flatMap((key) => [...key]),
  ];
}

/** registry-collect-note: `6 + 4n` felts. No assets. */
export interface RegistryCollectNoteParams {
  registryId: AccountIdLike;
  serial: Word4;
  /** One asset key per asset the collect sweeps. */
  assetKeys: readonly Word4[];
}

export function registryCollectNoteStorage(
  params: RegistryCollectNoteParams,
): bigint[] {
  return [
    ...accountIdFelts(params.registryId),
    ...params.serial,
    ...params.assetKeys.flatMap((key) => [...key]),
  ];
}

/** register-note: 8 felts. No assets. */
export interface RegisterNoteParams {
  registryId: AccountIdLike;
  poolId: AccountIdLike;
  asset0: AccountIdLike;
  asset1: AccountIdLike;
}

export function registerNoteStorage(params: RegisterNoteParams): bigint[] {
  return [
    ...accountIdFelts(params.registryId),
    ...accountIdFelts(params.poolId),
    ...accountIdFelts(params.asset0),
    ...accountIdFelts(params.asset1),
  ];
}
