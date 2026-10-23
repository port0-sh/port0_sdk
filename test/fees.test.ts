import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  COLLECT_MAX_KEYS,
  POOL_COLLECT_FEE_HOLD,
  REGISTRY_COLLECT_FEE_HOLD,
} from '../src/generated/fees.js'

/**
 * The generated fees module must match the file the contracts include.
 *
 * A stale generated copy publishes a value that no longer matches what the
 * contracts reserve, and it does so silently: the tooling would print and size
 * its sponsorship from a number nothing enforces. This test is the check that
 * `npm run generate` produces what is committed.
 */
const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOLD_SOURCE = join(
  SDK_ROOT,
  '..',
  'port0_contracts',
  'contracts',
  'collect-fee-hold.rs',
)

function declared(name: string): bigint {
  const source = readFileSync(HOLD_SOURCE, 'utf8')
  const match = source.match(new RegExp(`const ${name}: \\w+ = (\\d+);`))
  if (!match?.[1]) {
    throw new Error(`collect-fee-hold.rs declares no ${name}`)
  }
  return BigInt(match[1])
}

describe('generated fees', () => {
  it('matches the contract constants file', () => {
    expect(POOL_COLLECT_FEE_HOLD).toBe(declared('POOL_COLLECT_FEE_HOLD'))
    expect(REGISTRY_COLLECT_FEE_HOLD).toBe(declared('REGISTRY_COLLECT_FEE_HOLD'))
    expect(COLLECT_MAX_KEYS).toBe(declared('COLLECT_MAX_KEYS'))
  })

  it('holds are positive and the key cap is usable', () => {
    expect(POOL_COLLECT_FEE_HOLD).toBeGreaterThan(0n)
    expect(REGISTRY_COLLECT_FEE_HOLD).toBeGreaterThan(0n)
    expect(COLLECT_MAX_KEYS).toBeGreaterThan(0n)
  })
})
