#!/usr/bin/env node
// Regenerates the API types to a temp file and fails when they differ from the committed ones.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gen-api-"));
const tmp = join(dir, "schema.d.ts");
try {
  execFileSync("npx", ["openapi-typescript", "../backend/openapi.json", "-o", tmp], {
    stdio: "ignore",
  });
  const fresh = readFileSync(tmp, "utf8");
  const current = readFileSync("src/api/generated/schema.d.ts", "utf8");
  if (fresh !== current) {
    console.error("gen:api:check: src/api/generated/schema.d.ts is stale; run npm run gen:api");
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
