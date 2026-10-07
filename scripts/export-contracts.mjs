#!/usr/bin/env node
/**
 * Exports the compiled MidenXYK contracts into `src/generated/contracts.ts`.
 *
 * Each contract is a standalone cargo-miden crate. The compiled package is the
 * `out.masp` produced by `cargo miden build --release` at
 * `<contract>/target/miden/release/out.masp`.
 *
 * Usage:
 *   node scripts/export-contracts.mjs          # read existing artifacts
 *   node scripts/export-contracts.mjs --build  # rebuild contracts first
 *
 * The contracts directory is `../miden_xyk/contracts` by default; override
 * with the MIDEN_XYK_CONTRACTS_DIR environment variable.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(scriptDir, "..");
const contractsRoot = resolve(
  sdkRoot,
  process.env.MIDEN_XYK_CONTRACTS_DIR ?? "../miden_xyk/contracts",
);
const outDir = join(sdkRoot, "src", "generated");

const CONTRACTS = [
  { key: "pool", dir: "miden-xyk" },
  { key: "admin", dir: "admin-note" },
  { key: "mint", dir: "mint-note" },
  { key: "burn", dir: "burn-note" },
  { key: "swap", dir: "swap-note" },
  { key: "collect", dir: "collect-note" },
];

const build = process.argv.includes("--build");

if (build) {
  for (const { dir } of CONTRACTS) {
    const manifest = join(contractsRoot, dir, "Cargo.toml");
    console.log(`Building ${dir} ...`);
    execFileSync(
      "cargo",
      ["miden", "build", "--manifest-path", manifest, "--release"],
      { stdio: "inherit" },
    );
  }
}

const artifacts = {};
const sha256 = {};
for (const { key, dir } of CONTRACTS) {
  const maspPath = join(contractsRoot, dir, "target", "miden", "release", "out.masp");
  const bytes = readFileSync(maspPath);
  artifacts[key] = bytes.toString("base64");
  sha256[key] = createHash("sha256").update(bytes).digest("hex");
  console.log(`${key}: ${bytes.length} bytes, sha256 ${sha256[key]}`);
}

mkdirSync(outDir, { recursive: true });

const header = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/export-contracts.mjs [--build]
// Source: ${contractsRoot}

`;

const artifactBody = Object.entries(artifacts)
  .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
  .join("\n");

const shaBody = Object.entries(sha256)
  .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
  .join("\n");

const output = `${header}
export type ContractKind = "pool" | "admin" | "mint" | "burn" | "swap" | "collect";

/**
 * Base64-encoded compiled Miden packages (.masp) for each XYK contract.
 *
 * - \`pool\` is the account-component package; deserialize and pass to
 *   \`AccountComponent.fromPackage\`.
 * - The remaining entries are note packages; deserialize and pass to
 *   \`NoteScript.fromPackage\`.
 */
export const CONTRACT_ARTIFACTS: Record<ContractKind, string> = {
${artifactBody}
};

/** SHA-256 of each raw package, for build-time drift detection. */
export const CONTRACT_SHA256: Record<ContractKind, string> = {
${shaBody}
};

/** Wall-clock time this file was generated. */
export const GENERATED_AT: string = ${JSON.stringify(new Date().toISOString())};
`;

const outPath = join(outDir, "contracts.ts");
writeFileSync(outPath, output);
console.log(`Wrote ${outPath}`);
