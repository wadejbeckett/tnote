"use strict";
const assert = require("node:assert/strict");
const { FakeThunderbird, thunderbirdSchemas, flush, BASE_URL } = require("./thunderbird.js");

const schemas = thunderbirdSchemas();
/** Pass as { skip } to describe(): skips clearly when omni.ja is not available. */
const skip = schemas.ok ? false : `${schemas.reason} - schema-checked tests skipped`;

/**
 * Starts a fake Thunderbird with tNOTE's background page running.
 * @param {object} [o]
 * @param {object} [o.config]    FakeThunderbird config overrides
 * @param {object} [o.manifest]  manifest override
 * @param {string} [o.src]       add-on source directory override
 * @param {Array}  [o.messages]  addMessage() options, in id order (ids start at 1)
 * @param {Array}  [o.tags]      initial tag list (default: Thunderbird's five)
 * @param {object} [o.storage]   initial storage.local content
 * @param {object} [o.faults]    "ns.fn" -> Error (or (ctx) => Error|undefined), in force from startup (see tb.faults)
 */
async function boot(t, { config, manifest, src, messages = [{ subject: "Invoice 42" }], tags, storage = {}, faults = {} } = {}) {
  const tb = new FakeThunderbird({ config, manifest, src });
  if (t) {
    t.after(async () => {
      await flush(); // let pending page scripts finish before their documents close
      tb.dispose();
    });
  }
  if (tags) tb.tags = structuredClone(tags);
  Object.assign(tb.faults, faults);
  for (const [k, v] of Object.entries(storage)) tb.storage.set(k, v);
  const msgs = messages.map((m) => tb.addMessage(m));
  tb.startBackground();
  await flush();
  return { tb, msgs };
}

/** An extension page context (like note.html) whose messenger API is schema-checked. */
function pageApi(tb, name = "test page") {
  return tb.createContext(name, "addon_child", BASE_URL + "note.html").api;
}

/** Every call was valid, every API present, nothing deprecated, nothing failed unseen. */
function assertClean(tb, { allowUnhandled = false } = {}) {
  assert.deepEqual(tb.violations, [], "schema violations");
  assert.deepEqual(tb.missing, [], "APIs that would be undefined in Thunderbird");
  assert.deepEqual(tb.warnings, [], "schema warnings (deprecations, MV mismatches)");
  if (!allowUnhandled) assert.deepEqual(tb.unhandled.map(String), [], "unhandled promise rejections in the add-on");
  assert.deepEqual(
    tb.consoleMessages.filter((m) => m.level === "error" || m.level === "jsdomError"),
    [],
    "console errors"
  );
}

function tagsOf(tb, id) {
  return tb.header(id).tags;
}

function popupText(popup) {
  return {
    subject: popup.page.document.getElementById("subject").textContent,
    text: popup.page.document.getElementById("text").value,
  };
}

/** console.warn output of the add-on, as plain strings. */
function warnings(tb) {
  return tb.consoleMessages.filter((m) => m.level === "warn").map((m) => m.args.map(String).join(" "));
}

/** Moves the fake clock forward and lets the work it triggered finish. */
async function advance(tb, ms) {
  tb.clock.advance(ms);
  await flush();
}

module.exports = { boot, pageApi, assertClean, tagsOf, popupText, warnings, advance, flush, skip, schemas, FakeThunderbird, BASE_URL };
