/**
 * Build identity mapping: fetch raw anime-list-full.json, trim each row,
 * gzip the result, and enforce a size gate.
 *
 * Why this exists: ensures the trimmed identity data stays within the
 * size budget for the add-on. The gzip artefact is not vendored (see
 * .gitignore + ADR-018/D2).
 *
 * On any fetch/parse failure: throw and write nothing — no stale artefact.
 */

import { trimIdentityRow } from '../dist/identity/trim.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDENTITY_PIN = process.env.IDENTITY_PIN || '0000000000000000000000000000000000000000'; // overridden by CI

const PIN = IDENTITY_PIN;

function throwIfFail(condition, msg) {
  if (!condition) throw new Error(msg);
}

// Fetch the commit-pinned URL
let data;
try {
  const url = `https://raw.githubusercontent.com/Fribb/anime-lists/${PIN}/anime-list-full.json`;
  const response = await fetch(url);
  throwIfFail(response.ok, `Failed to fetch ${url} (status ${response.status})`);
  data = await response.json();
} catch (e) {
  // On any fetch/parse failure: throw and write nothing.
  throw new Error(`identity:build fetch/parse failure: ${e instanceof Error ? e.message : e}`);
}

// Map every row through trimIdentityRow, drop nulls
const allRows = Object.values(data);
const trimmed = allRows.map(trimIdentityRow).filter((r) => r !== null);

// Prepare the JSON payload
const payload = {
  pin: PIN,
  builtAt: new Date().toISOString(),
  rows: trimmed,
};

const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
const gz = gzipSync(jsonBytes, { level: 9 }); // level 9 — load-bearing literal
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'identity.min.json.gz');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, gz);

// Size gate
const byteCount = gz.byteLength;
const HEADROOM_UNDER_512K = 512_000 - byteCount;
const HEADROOM_UNDER_480K = 480_000 - byteCount;

if (byteCount > 512_000) {
  console.error(`identity:build GZIP too large: ${byteCount} bytes (over 512,000 by ${byteCount - 512_000})`);
  process.exit(1);
}
if (byteCount > 480_000) {
  console.warn(`identity:build GZIP warning: ${byteCount} bytes (over 480,000 by ${byteCount - 480_000})`);
}
console.log(`identity:build rows=${trimmed.length} bytes=${byteCount} level=9 pin=${PIN} headroom_512k=${HEADROOM_UNDER_512K}`);