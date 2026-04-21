#!/usr/bin/env node
// Bundle beatctl into a single Node executable.
//
// Why a script instead of an inline package.json entry: the banner needs to
// be a JavaScript literal (for createRequire + warning suppression) and
// shell-escaping that through JSON quickly turns into a mess. Keeping the
// build as code also makes it easy to grow — e.g. emit platform-specific
// binaries, bump targets, or sign the output later.

import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const outfile = resolve(pkgRoot, "bin/beatctl");

// Bundled code is ESM, but several transitive deps (e.g. commander) still
// ship CJS that calls `require()`. Provide a createRequire shim so those
// calls work at runtime. The warning silencer hides DEP0040 / DEP0169 from
// @kubernetes/client-node's deps — purely cosmetic, users can still opt in
// with `NODE_OPTIONS=--trace-deprecation`.
const banner = [
  "import { createRequire as __createRequire } from 'module';",
  "const require = __createRequire(import.meta.url);",
  "process.removeAllListeners('warning');",
].join(" ");

mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(pkgRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile,
  packages: "bundle",
  minify: true,
  banner: { js: banner },
  // esbuild preserves the #!/usr/bin/env node shebang from src/index.ts and
  // places it before our banner — the resulting first line is the shebang,
  // second line is the banner, which is valid JS.
  logLevel: "info",
});

if (result.errors.length) process.exit(1);

chmodSync(outfile, 0o755);
console.log(`wrote ${outfile}`);
