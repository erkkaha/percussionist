#!/usr/bin/env node
// Bundle beatctl into a self-contained Bun single-file executable.
//
// Produces bin/beatctl — no Node or Bun runtime required on the target machine.
// Cross-compilation targets (linux-x64, linux-arm64, darwin-x64, darwin-arm64,
// windows-x64) can be added via the --target flag if needed.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const outfile = resolve(pkgRoot, "bin/beatctl");

mkdirSync(dirname(outfile), { recursive: true });

execFileSync(
  "bun",
  [
    "build",
    "--compile",
    "--minify",
    resolve(pkgRoot, "src/index.ts"),
    "--outfile", outfile,
  ],
  { stdio: "inherit" },
);

chmodSync(outfile, 0o755);
console.log(`wrote ${outfile}`);
