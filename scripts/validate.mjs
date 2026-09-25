// Validates the localization files. On pull requests it also checks the change is translation-only:
// the English side (ns/key/source/sourceHash/origin) is owned by the Unreal export and must not change.
//   node scripts/validate.mjs                 -> structure + translation checks
//   node scripts/validate.mjs --base main     -> + "translations only" diff against origin/main
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const STATUSES = new Set(["untranslated", "machine", "reviewed", "approved", "stale"]);
const TRANSLATED = new Set(["machine", "reviewed", "approved"]);
const ENGLISH_FIELDS = ["source", "sourceHash", "origin"];

const baseIndex = process.argv.indexOf("--base");
const base = baseIndex > 0 ? process.argv[baseIndex + 1] : null;

const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

// Same rules as the Unreal import (UIRRLocSyncLibrary): {Arguments} and rich-text closers must survive.
function formatArgs(text) {
  const args = new Set();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`") { i++; continue; }
    if (text[i] !== "{") continue;
    const end = text.indexOf("}", i + 1);
    if (end < 0) break;
    args.add(text.slice(i + 1, end));
    i = end;
  }
  return [...args].sort().join(",");
}
const closers = (text) => text.split("</>").length - 1;

function readBase(file) {
  try {
    return JSON.parse(execSync(`git show origin/${base}:${file}`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

const areaFiles = fs.existsSync("Areas")
  ? fs.readdirSync("Areas").filter((f) => f.endsWith(".json")).map((f) => path.posix.join("Areas", f))
  : [];

for (const file of ["Project.json", "Glossary.json"]) {
  if (!fs.existsSync(file)) continue;
  try { JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(file, `invalid JSON (${e.message})`); }
}

for (const file of areaFiles) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(file, `invalid JSON (${e.message})`);
    continue;
  }
  if (!Array.isArray(doc.entries)) { fail(file, "missing entries array"); continue; }

  for (const entry of doc.entries) {
    const id = `${entry.ns},${entry.key}`;
    if (typeof entry.key !== "string" || typeof entry.source !== "string") { fail(file, `entry without key/source (${id})`); continue; }
    for (const [culture, tr] of Object.entries(entry.t || {})) {
      if (!STATUSES.has(tr.status)) fail(file, `${id} [${culture}]: unknown status "${tr.status}"`);
      if (typeof tr.text !== "string") { fail(file, `${id} [${culture}]: text is not a string`); continue; }
      if (TRANSLATED.has(tr.status) && !tr.text) fail(file, `${id} [${culture}]: status ${tr.status} but no text`);
      if (!tr.text || !TRANSLATED.has(tr.status)) continue;
      if (formatArgs(tr.text) !== formatArgs(entry.source)) fail(file, `${id} [${culture}]: {arguments} differ from the English text`);
      if (closers(tr.text) !== closers(entry.source)) fail(file, `${id} [${culture}]: rich-text tag count differs from the English text`);
      if (entry.maxLength > 0 && tr.text.length > entry.maxLength) fail(file, `${id} [${culture}]: ${tr.text.length} chars, max ${entry.maxLength}`);
    }
  }

  if (!base) continue;
  const before = readBase(file);
  if (!before) { fail(file, "new area file — areas are created by the Unreal export, not by pull requests"); continue; }
  const beforeById = new Map(before.entries.map((e) => [`${e.ns}\u001f${e.key}`, e]));
  const afterIds = new Set();
  for (const entry of doc.entries) {
    const key = `${entry.ns}\u001f${entry.key}`;
    afterIds.add(key);
    const old = beforeById.get(key);
    if (!old) { fail(file, `${entry.ns},${entry.key}: entry added — only the Unreal export adds entries`); continue; }
    for (const field of ENGLISH_FIELDS) {
      if (old[field] !== entry[field]) fail(file, `${entry.ns},${entry.key}: "${field}" changed — English text is edited in Unreal`);
    }
  }
  for (const key of beforeById.keys()) {
    if (!afterIds.has(key)) fail(file, `${key.replace("\u001f", ",")}: entry removed — only the Unreal export removes entries`);
  }
}

if (base) {
  const changed = execSync(`git diff --name-only origin/${base}...HEAD`, { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of changed) {
    if (file === "Project.json" || file.startsWith(".github/") || file.startsWith("scripts/")) {
      fail(file, "only Areas/*.json and Glossary.json may change in a translation pull request");
    }
  }
}

if (errors.length) {
  console.error(errors.map((e) => `FAIL ${e}`).join("\n"));
  process.exit(1);
}
console.log(`OK — ${areaFiles.length} area file(s)${base ? `, translation-only against ${base}` : ""}`);
