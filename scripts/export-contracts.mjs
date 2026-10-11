#!/usr/bin/env node
/**
 * Exports the compiled MidenXYK contracts into `src/generated/contracts.ts`.
 *
 * The contracts are workspace members of `../miden_xyk`, so `cargo miden
 * build` writes each package to `<workspace>/target/miden/release/<name>.masp`.
 * The artifact name is the crate package name, with underscores or hyphens as
 * declared in the crate manifest.
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
const workspaceTarget = resolve(contractsRoot, "..", "target", "miden", "release");
const outDir = join(sdkRoot, "src", "generated");

const CONTRACTS = [
  { key: "pool", dir: "miden-xyk", artifact: "miden-xyk.masp" },
  { key: "mint", dir: "mint-note", artifact: "mint_note.masp" },
  { key: "burn", dir: "burn-note", artifact: "burn_note.masp" },
  { key: "swap", dir: "swap-note", artifact: "swap_note.masp" },
  { key: "collect", dir: "collect-note", artifact: "collect_note.masp" },
  { key: "registry", dir: "pool-registry", artifact: "pool-registry.masp" },
  { key: "register", dir: "register-note", artifact: "register_note.masp" },
  {
    key: "registry-collect",
    dir: "registry-collect-note",
    artifact: "registry_collect_note.masp",
  },
];

const build = process.argv.includes("--build");

if (build) {
  for (const { dir } of CONTRACTS) {
    const manifest = join(contractsRoot, dir, "Cargo.toml");
    console.log(`Building ${dir} ...`);
    execFileSync(
      "cargo",
      ["miden", "build", "--manifest-path", manifest, "--release"],
      // Run from the contracts workspace root so cargo-miden writes packages to
      // the workspace target, not the caller's working directory.
      { stdio: "inherit", cwd: resolve(contractsRoot, "..") },
    );
  }
}

const artifacts = {};
const sha256 = {};
for (const { key, artifact } of CONTRACTS) {
  const maspPath = join(workspaceTarget, artifact);
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
  .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  .join("\n");

const shaBody = Object.entries(sha256)
  .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
  .join("\n");

const output = `${header}
export type ContractKind =
  | "pool"
  | "registry"
  | "mint"
  | "burn"
  | "swap"
  | "collect"
  | "register"
  | "registry-collect";

/**
 * Base64-encoded compiled Miden packages (.masp) for each contract.
 *
 * - \`pool\` and \`registry\` are account-component packages; deserialize and
 *   pass to \`AccountComponent.fromPackage\`.
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
