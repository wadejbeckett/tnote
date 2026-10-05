"use strict";
// manifest.json against Thunderbird's manifest schema, the files it points at,
// and a static check that every messenger./browser. API the source mentions
// exists in its context and is covered by the manifest's permissions.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { skip, schemas, FakeThunderbird, BASE_URL } = require("./harness/setup.js");
const { ValidationContext } = require("./harness/schemas.js");
const { readManifest, readSource, SRC } = require("./harness/thunderbird.js");

function validateManifest(manifest) {
  const ctx = new ValidationContext({ manifestVersion: manifest.manifest_version, url: BASE_URL });
  const r = schemas.root.validateType("manifest", "WebExtensionManifest", manifest, ctx);
  return { error: r.error, warnings: ctx.warnings };
}

/** Which kind of context each source file runs in. */
function scriptContexts(manifest) {
  const map = new Map();
  for (const s of manifest.background.scripts) map.set(s, "addon_child");
  for (const key of ["message_display_action", "browser_action"]) {
    const html = manifest[key]?.default_popup;
    if (!html) continue;
    for (const m of readSource(html).matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) map.set(m[1], "addon_child");
  }
  // Files registered with messageDisplayScripts.register run as content scripts.
  for (const s of manifest.background.scripts) {
    const src = readSource(s);
    for (const reg of src.matchAll(/messageDisplayScripts\.register\(([\s\S]*?)\);/g)) {
      for (const f of reg[1].matchAll(/file:\s*"([^"]+)"/g)) map.set(f[1], "content_child");
    }
  }
  return map;
}

/** messenger.a.b.c chains used in a source file (call targets and event objects). */
function apiChains(source) {
  const chains = new Set();
  for (const m of source.matchAll(/\b(?:messenger|browser)((?:\.[A-Za-z_$][\w$]*)+)/g)) {
    chains.add(m[1].slice(1));
  }
  return [...chains];
}

function scan(manifest) {
  const tb = new FakeThunderbird({ manifest });
  const problems = [];
  const used = [];
  try {
    for (const [file, envType] of scriptContexts(manifest)) {
      const api = tb.createContext(file, envType, BASE_URL + file).api;
      for (const chain of apiChains(readSource(file))) {
        used.push(`${file}: ${chain}`);
        let o = api;
        for (const part of chain.split(".")) {
          const before = tb.missing.length;
          o = o?.[part];
          if (o === undefined) {
            const why = tb.missing.slice(before).map((m) => `${m.api} ${m.why}`).join("; ") || "does not exist in the schema";
            problems.push(`${file} (${envType}): ${chain} -> ${why}`);
            break;
          }
        }
      }
    }
  } finally {
    tb.dispose();
  }
  return { problems, used };
}

describe("manifest.json", { skip }, () => {
  it("is valid for Thunderbird with no errors or warnings", () => {
    const { error, warnings } = validateManifest(readManifest());
    assert.equal(error, undefined);
    assert.deepEqual(warnings, []);
  });

  it("negative control: an unknown permission and key are reported", () => {
    const m = readManifest();
    m.permissions = [...m.permissions, "messagesTagz"];
    m.message_display_action.default_poopup = "note.html";
    const { warnings } = validateManifest(m);
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.match(warnings[0], /messagesTagz/);
    assert.match(warnings[1], /default_poopup: An unexpected property/);
  });

  it("points only at files that exist in src/", () => {
    const m = readManifest();
    const files = [
      ...m.background.scripts,
      m.message_display_action.default_popup,
      m.message_display_action.default_icon,
      m.browser_action.default_popup,
      m.browser_action.default_icon,
      ...Object.values(m.icons),
      ...scriptContexts(m).keys(),
    ];
    for (const f of new Set(files)) assert.ok(fs.existsSync(path.join(SRC, f)), `${f} exists`);
  });

  it("classifies every .js file in src/ (background, popup page or message display script)", () => {
    const known = scriptContexts(readManifest());
    const js = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));
    assert.deepEqual(js.filter((f) => !known.has(f)), []);
    assert.equal(known.get("display.js"), "content_child");
    assert.equal(known.get("note.js"), "addon_child");
    assert.equal(known.get("list.js"), "addon_child", "the toolbar button's All notes page (v0.5.0)");
  });

  it("every API the source uses exists in its context and is covered by the manifest permissions", (t) => {
    const { problems, used } = scan(readManifest());
    t.diagnostic(`API uses checked: ${used.length}`);
    assert.ok(used.length >= 20, "the scan found the API uses");
    assert.deepEqual(problems, []);
  });

  it("negative control: dropping messagesTags makes the scan fail for tags.create/update", () => {
    const m = readManifest();
    m.permissions = m.permissions.filter((p) => p !== "messagesTags");
    const { problems } = scan(m);
    assert.deepEqual(problems, [
      "background.js (addon_child): messages.tags.create -> messages.tags.create needs permission messagesTags",
      "background.js (addon_child): messages.tags.update -> messages.tags.update needs permission messagesTags",
    ]);
  });

  it("asks for accountsRead, a permission Thunderbird's manifest schema knows (v0.5.0)", () => {
    const m = readManifest();
    assert.ok(m.permissions.includes("accountsRead"));
    assert.equal(new Set(m.permissions).size, m.permissions.length, "no permission listed twice");
    // The same manifest with a misspelt permission is reported, so the clean
    // validation above really covers accountsRead.
    const typo = { ...m, permissions: m.permissions.map((p) => (p === "accountsRead" ? "accountRead" : p)) };
    const { warnings } = validateManifest(typo);
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], /accountRead/);
  });

  it("negative control: without accountsRead the static scan still passes, but selecting and folder searches reject at run time", async (t) => {
    // The schema lists ["messagesRead", "accountsRead"] for setSelectedMessages,
    // and an entry is injected when any one of its permissions is granted, so
    // the scan cannot catch this; the implementation checks both
    // (ext-mailTabs.js:641-648). Likewise messages.query with folderId needs
    // accountsRead (ExtensionMessages.sys.mjs:2351-2357), which only the
    // implementation checks. v0.6.0 would then only log a failed selection
    // and search every folder each time.
    const m = readManifest();
    m.permissions = m.permissions.filter((p) => p !== "accountsRead");
    assert.deepEqual(scan(m).problems, []);
    const tb = new FakeThunderbird({ manifest: m });
    t.after(() => tb.dispose());
    const api = tb.createContext("no accountsRead", "addon_child", BASE_URL + "list.html").api;
    await assert.rejects(api.mailTabs.setSelectedMessages(tb.mailTab.id, []), {
      message: 'Using mailTabs.setSelectedMessages() requires the "accountsRead" and the "messagesRead" permission',
    });
    await assert.rejects(api.messages.query({ folderId: "account1://INBOX", headerMessageId: "x@example.com", messagesPerPage: 1 }), {
      message: 'Querying by folder requires the "accountsRead" permission',
    });
    const full = new FakeThunderbird();
    t.after(() => full.dispose());
    const ok = full.createContext("with accountsRead", "addon_child", BASE_URL + "list.html").api;
    assert.equal(await ok.mailTabs.setSelectedMessages(full.mailTab.id, []), undefined);
    assert.deepEqual((await ok.messages.query({ folderId: "account1://INBOX", headerMessageId: "x@example.com", messagesPerPage: 1 })).messages, []);
  });

  it("is version 0.6.1", () => {
    assert.equal(readManifest().version, "0.6.1");
  });

  it("tnote.xpi contains exactly the current src/ files plus LICENSE", (t) => {
    const xpi = path.join(SRC, "..", "tnote.xpi");
    if (!fs.existsSync(xpi)) return t.skip("tnote.xpi not built");
    const srcFiles = filesUnder(SRC);
    assert.deepEqual(xpiFiles(xpi).sort(), [...srcFiles, "LICENSE"].sort());
    for (const f of srcFiles) {
      const packed = execFileSync("unzip", ["-p", xpi, f]);
      assert.ok(packed.equals(fs.readFileSync(path.join(SRC, f))), `${f} in tnote.xpi matches src/`);
    }
    const licence = execFileSync("unzip", ["-p", xpi, "LICENSE"]);
    assert.ok(licence.equals(fs.readFileSync(path.join(SRC, "..", "LICENSE"))), "LICENSE in tnote.xpi matches the project's");
  });
});

/** Files (not directories) under dir, as posix paths relative to it. */
function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out;
}

function xpiFiles(xpi) {
  return execFileSync("unzip", ["-Z1", xpi], { encoding: "utf8" }).split("\n").filter((f) => f && !f.endsWith("/"));
}

describe("build.sh", () => {
  it("leaves hidden and backup files out, adds LICENSE at the root, and builds byte-identical archives", (t) => {
    try {
      execFileSync("zip", ["-v"], { stdio: "ignore" });
    } catch {
      return t.skip("zip is not installed");
    }
    const project = path.join(SRC, "..");
    if (!fs.existsSync(path.join(project, "build.sh"))) return t.skip(`no build.sh next to ${SRC}`);
    // Build in a copy, never over the project's own tnote.xpi.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnote-build-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.copyFileSync(path.join(project, "build.sh"), path.join(dir, "build.sh"));
    fs.copyFileSync(path.join(project, "LICENSE"), path.join(dir, "LICENSE"));
    fs.cpSync(SRC, path.join(dir, "src"), { recursive: true });
    const wanted = filesUnder(path.join(dir, "src"));
    const junk = [
      ".DS_Store",
      "icons/.hidden.svg",
      "note.js~",
      "background.js.bak",
      ".note.js.swp",
      "note.js.swp",
      ".git/config",
      // v0.4.1: Emacs autosave files and patch/merge leftovers.
      "#note.js#",
      "icons/#note.svg#",
      "note.js.orig",
      "icons/note.svg.orig",
    ];
    for (const f of junk) {
      fs.mkdirSync(path.dirname(path.join(dir, "src", f)), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", f), "junk");
    }

    execFileSync("sh", [path.join(dir, "build.sh")], { stdio: "ignore" });
    const xpi = path.join(dir, "tnote.xpi");
    const packed = xpiFiles(xpi);
    for (const f of junk) assert.ok(!packed.includes(f), `${f} is left out`);
    assert.deepEqual(packed.sort(), [...wanted, "LICENSE"].sort());
    const details = execFileSync("unzip", ["-Zv", xpi], { encoding: "utf8" });
    const extra = [...details.matchAll(/length of extra field:\s+(\d+) bytes/g)].map((m) => Number(m[1]));
    assert.ok(extra.length > 0 && extra.every((n) => n === 0), "zip -X: no extra fields (uid/gid, extended times)");

    const first = fs.readFileSync(xpi);
    execFileSync("sh", [path.join(dir, "build.sh")], { stdio: "ignore" });
    assert.ok(fs.readFileSync(xpi).equals(first), "a rebuild of the same files is byte-identical");
  });
});
