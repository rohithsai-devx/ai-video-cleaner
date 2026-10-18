#!/usr/bin/env node
// Enforces the frontend layout from .coding-powers/specs/phase2.md. Run from frontend/: node scripts/check-layout.mjs
// Workers must not edit this file; acceptance A5 pins its sha256.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const TOP = new Set(["app", "features", "api", "ui", "lib"]);
const FEATURES = new Set(["auth", "videos", "recorder", "runs", "review", "shares"]);
const CODE = /\.(ts|tsx|mts)$/;
// Only these places talk to the network directly; everything else goes through src/api.
const FETCH_OK = ["api/", "app/api/", "lib/server/"];

const errors = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (!existsSync(SRC)) {
  console.error("layout: frontend/src is missing");
  process.exit(1);
}

const TOP_FILES = new Set(["proxy.ts", "instrumentation.ts"]);
for (const name of readdirSync(SRC)) {
  const isDir = statSync(join(SRC, name)).isDirectory();
  if (isDir ? !TOP.has(name) : !TOP_FILES.has(name)) {
    err(`src/${name}`, `top level holds only ${[...TOP].join(", ")} and ${[...TOP_FILES].join(", ")}`);
  }
}
const featDir = join(SRC, "features");
if (existsSync(featDir)) {
  for (const name of readdirSync(featDir)) {
    if (!FEATURES.has(name)) err(`src/features/${name}`, `feature must be one of ${[...FEATURES].join(", ")}`);
  }
}

for (const abs of walk(SRC).filter((p) => CODE.test(p))) {
  const rel = relative(SRC, abs).split(sep).join("/");
  const file = `src/${rel}`;
  const [top, second] = rel.split("/");
  const text = readFileSync(abs, "utf8");
  const generated = rel.startsWith("api/generated/");
  const base = rel.split("/").pop();

  if (!generated && !/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*\.(ts|tsx|mts)$/.test(base) && !/^\[.+\]/.test(base)) {
    err(file, "file names are kebab-case");
  }
  if (/^index\.(ts|tsx)$/.test(base) && top !== "app") err(file, "no barrel index files (bundle-barrel-imports)");
  if (generated) continue;

  const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*["']@\/([^"']+)["']/g)].map((m) => m[1]);
  for (const imp of imports) {
    const [itop, isecond] = imp.split("/");
    if (top === "ui" && itop !== "ui" && itop !== "lib") err(file, `ui/ may import only ui/ and lib/ (got @/${imp})`);
    if (top === "api" && itop !== "api" && itop !== "lib") err(file, `api/ may import only api/ and lib/ (got @/${imp})`);
    if (top === "lib" && itop !== "lib" && itop !== "api") err(file, `lib/ may import only lib/ and api/ (got @/${imp})`);
    if (top === "features" && itop === "features" && isecond !== second) err(file, `features do not import other features; compose them in app/ (got @/${imp})`);
    if (top === "features" && itop === "app") err(file, `features do not import app/ (got @/${imp})`);
    if (imp.startsWith("lib/server") && /^\s*["']use client["']/m.test(text)) err(file, "client components cannot import lib/server");
  }
  if (/\bfetch\s*\(/.test(text) && !FETCH_OK.some((p) => rel.startsWith(p))) {
    err(file, "call the network through src/api (generated client), not fetch()");
  }
  if (/document\.cookie|localStorage\.\w+\(\s*["'][^"']*token/i.test(text)) {
    err(file, "the session token lives only in the httpOnly cookie");
  }
  const schemaNames = "Video|VideoCreated|Run|RunSummary|Proposal|ProposalView|Script|ScriptBlock|EditPlan|EDLEntry|SegContext|ShareCreated|SharePublic|Token|RunStatusEvent|RunProposalReadyEvent|RunDoneEvent|RunFailedEvent";
  if (new RegExp(`^\\s*export\\s+(interface|type)\\s+(${schemaNames})\\b`, "m").test(text) && top !== "api") {
    err(file, "API types come from src/api/generated; do not redeclare them");
  }
}

if (errors.length) {
  console.error(errors.map((e) => `layout: ${e}`).join("\n"));
  process.exit(1);
}
console.log("layout ok");
