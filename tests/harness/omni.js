"use strict";
// Loads Thunderbird's real WebExtension API schemas at test time.
//
// Source of truth: the installed Thunderbird's omni.ja (default
// /usr/lib/thunderbird/omni.ja, override with TB_OMNI). TB_OMNI may also point
// at a directory that already holds the extracted omni.ja tree.
//
// Which schema files Thunderbird loads is read from the same registries the
// application uses: chrome/messenger/content/messenger/ext-mail.json and
// chrome/toolkit/content/extensions/ext-toolkit.json, plus the toolkit base
// schemas (manifest, types, events, extension_types) that every Gecko app loads.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_OMNI = "/usr/lib/thunderbird/omni.ja";

const REGISTRIES = [
  "chrome/messenger/content/messenger/ext-mail.json",
  "chrome/toolkit/content/extensions/ext-toolkit.json",
];
const BASE_SCHEMAS = [
  "chrome://extensions/content/schemas/manifest.json",
  "chrome://extensions/content/schemas/types.json",
  "chrome://extensions/content/schemas/events.json",
  "chrome://extensions/content/schemas/extension_types.json",
];

function chromeUrlToPath(url) {
  let m = /^chrome:\/\/extensions\/content\/(.*)$/.exec(url);
  if (m) return "chrome/toolkit/content/extensions/" + m[1];
  m = /^chrome:\/\/messenger\/content\/(.*)$/.exec(url);
  if (m) return "chrome/messenger/content/messenger/" + m[1];
  throw new Error("Unknown chrome URL " + url);
}

// Gecko's own loader: "look for the first '[' character" to skip the license
// comment (Schemas.sys.mjs readJSON). Registries start with '{'.
function parseChromeJson(text, opener) {
  return JSON.parse(text.slice(text.indexOf(opener)));
}

let cached;

function locate() {
  const omni = process.env.TB_OMNI || DEFAULT_OMNI;
  if (!fs.existsSync(omni)) {
    return { ok: false, reason: `Thunderbird omni.ja not found at ${omni} (set TB_OMNI to its path)` };
  }
  return { ok: true, omni };
}

function extract(omni) {
  if (fs.statSync(omni).isDirectory()) return { root: omni, cleanup() {} };
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
  } catch {
    throw new Error("the `unzip` command is needed to read omni.ja");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tnote-omni-"));
  try {
    execFileSync(
      "unzip",
      [
        "-qq",
        "-o",
        omni,
        "chrome/messenger/content/messenger/schemas/*",
        "chrome/toolkit/content/extensions/schemas/*",
        ...REGISTRIES,
        "-d",
        root,
      ],
      // unzip exits 1 for warnings such as the optimized-jar layout; the files
      // are still extracted, so only a missing registry counts as failure below.
      { stdio: "ignore" }
    );
  } catch (e) {
    if (!fs.existsSync(path.join(root, REGISTRIES[0]))) throw e;
  }
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function readVersion(omni) {
  const dir = fs.statSync(omni).isDirectory() ? omni : path.dirname(omni);
  try {
    const ini = fs.readFileSync(path.join(dir, "application.ini"), "utf8");
    return /^Version=(.*)$/m.exec(ini)?.[1] || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * @returns {{ok:true, omni:string, version:string, files:Array<{url:string, json:Array}>}
 *          | {ok:false, reason:string}}
 */
function loadThunderbirdSchemas() {
  if (cached) return cached;
  const where = locate();
  if (!where.ok) return (cached = where);
  const { root, cleanup } = extract(where.omni);
  try {
    const urls = new Set(BASE_SCHEMAS);
    for (const reg of REGISTRIES) {
      const json = parseChromeJson(fs.readFileSync(path.join(root, reg), "utf8"), "{");
      for (const mod of Object.values(json)) {
        if (mod.schema) urls.add(mod.schema);
      }
    }
    const files = [];
    for (const url of urls) {
      const p = path.join(root, chromeUrlToPath(url));
      files.push({ url, json: parseChromeJson(fs.readFileSync(p, "utf8"), "[") });
    }
    cached = { ok: true, omni: where.omni, version: readVersion(where.omni), files };
  } finally {
    cleanup();
  }
  return cached;
}

module.exports = { loadThunderbirdSchemas, DEFAULT_OMNI };
