"use strict";
// The validator itself: it must reject what Thunderbird 153 rejects, using the
// schemas read from the installed omni.ja at test time.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { skip, schemas, FakeThunderbird, BASE_URL, flush, advance } = require("./harness/setup.js");
const { ValidationContext } = require("./harness/schemas.js");
const { readManifest } = require("./harness/thunderbird.js");

function worldWith(manifestPatch = {}) {
  const manifest = { ...readManifest(), ...manifestPatch };
  return new FakeThunderbird({ manifest });
}

function api(tb, envType = "addon_child") {
  return tb.createContext("validator test", envType, BASE_URL + "_generated_background_page.html").api;
}

describe("Thunderbird schemas from omni.ja", { skip }, () => {
  it("loads the installed Thunderbird's schemas", (t) => {
    t.diagnostic(`omni.ja: ${schemas.omni} (Thunderbird ${schemas.version}), ${schemas.files.length} schema files`);
    for (const ns of ["windows", "menus", "messages", "messages.tags", "messageDisplay", "messageDisplayAction", "browserAction", "messageDisplayScripts", "storage", "runtime", "tabs"]) {
      assert.ok(schemas.root.namespace(ns), `namespace ${ns} present`);
    }
  });

  it("windows.json marks createData.focused as unsupported (the v0.2.0 root cause)", () => {
    const create = schemas.root.lookup("windows", "functions", "create").schema;
    assert.equal(create.parameters[0].properties.focused.unsupported, true);
  });
});

describe("schema validation of API calls", { skip }, () => {
  it("REGRESSION v0.2.0: windows.create({focused: true}) is rejected synchronously", (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const messenger = api(tb);
    assert.throws(
      () => messenger.windows.create({ url: "note.html?id=7", type: "popup", width: 440, height: 300, focused: true }),
      /Type error for parameter createData \(Property "focused" is unsupported by Firefox\) for windows\.create\./
    );
    assert.equal(tb.popups.length, 0, "no window was opened");
    // Even an explicit undefined counts: Gecko tests `prop in properties`.
    assert.throws(() => messenger.windows.create({ url: "note.html", focused: undefined }), /unsupported/);
  });

  it("accepts the v0.3.1 fallback windows.create call and resolves its URL against the extension", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    const win = await api(tb).windows.create({ url: "note.html?id=7", type: "popup", width: 440, height: 300 });
    assert.equal(win.type, "popup");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=7");
    assert.deepEqual(tb.violations, []);
  });

  it("accepts the v0.4.0 fallback tabs.create call and resolves its URL against the extension", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    const tab = await api(tb).tabs.create({ url: "note.html?id=7", windowId: tb.mainWindow.id });
    assert.equal(tab.type, "content");
    assert.equal(tab.windowId, tb.mainWindow.id);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=7");
    assert.deepEqual(tb.violations, []);
    assert.throws(() => api(tb).tabs.create({ url: "note.html", windowId: "1" }), /Expected integer instead of "1"/);
    assert.throws(() => api(tb).tabs.create({ url: "note.html", focused: true }), /Unexpected property "focused"/);
  });

  it("rejects unknown properties", (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    assert.throws(
      () => api(tb).menus.create({ id: "x", title: "X", contexts: ["message_list"], bogus: 1 }),
      /Unexpected property "bogus"/
    );
  });

  it("rejects wrong types", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const m = api(tb);
    assert.throws(() => m.menus.update("mail-note", { enabled: "yes" }), /Expected boolean instead of "yes"/);
    assert.throws(() => m.messages.get("7"), /Incorrect argument types for messages\.get\./);
    assert.throws(() => m.windows.create({ width: 440.5 }), /Expected integer instead of 440\.5/);
    assert.throws(() => m.messages.get(0), /Integer 0 is too small \(must be at least 1\)/);
  });

  it("rejects enum and pattern violations", (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const m = api(tb);
    assert.throws(() => m.menus.create({ id: "x", contexts: ["message_lists"] }), /matches none of the allowed choices|Invalid enumeration value/);
    assert.throws(() => m.messages.tags.create("mailnote", "Note", "green"), /must match/);
    assert.throws(() => m.messages.tags.update("bad key", { color: "#2E8B57" }), /must match/);
  });

  it("rejects missing required parameters", (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    assert.throws(() => api(tb).messages.update(5), /Incorrect argument types for messages\.update\./);
  });

  it("honours manifest-version gating (tabs.query mailTab is MV2-only)", () => {
    const fn = schemas.root.lookup("tabs", "functions", "query");
    const mv2 = new ValidationContext({ manifestVersion: 2 });
    assert.doesNotThrow(() => schemas.root.checkParameters(fn.schema, fn.ns, "tabs.query", [{ mailTab: true }], mv2));
    const mv3 = new ValidationContext({ manifestVersion: 3 });
    assert.throws(() => schemas.root.checkParameters(fn.schema, fn.ns, "tabs.query", [{ mailTab: true }], mv3), /Unexpected property "mailTab"/);
  });

  it("removes APIs the manifest has no permission for, as Gecko does", (t) => {
    const manifest = readManifest();
    const tb = worldWith({ permissions: manifest.permissions.filter((p) => p !== "messagesUpdate" && p !== "messagesTagsList") });
    t.after(() => tb.dispose());
    const m = api(tb);
    assert.equal(typeof m.messages.get, "function");
    assert.equal(m.messages.update, undefined);
    assert.equal(m.messages.tags.list, undefined);
    assert.deepEqual(
      tb.missing.map((x) => `${x.api}: ${x.why}`),
      ["messages.update: needs permission messagesUpdate", "messages.tags.list: needs permission messagesTagsList"]
    );
  });

  it("gives action APIs only to add-ons that declare the action", (t) => {
    const manifest = readManifest();
    delete manifest.browser_action;
    const tb = new FakeThunderbird({ manifest });
    t.after(() => tb.dispose());
    assert.equal(api(tb).browserAction, undefined);
    assert.equal(typeof api(tb).messageDisplayAction.openPopup, "function");
  });

  it("limits content scripts to content-allowed APIs", (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const c = api(tb, "content_child");
    assert.equal(typeof c.runtime.sendMessage, "function");
    assert.equal(typeof c.storage.onChanged.addListener, "function");
    assert.equal(typeof c.storage.local.get, "function");
    assert.equal(c.runtime.openOptionsPage, undefined);
    assert.equal(c.messages, undefined);
    assert.equal(c.menus.create, undefined);
  });

  it("checks event listeners are functions", (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    assert.throws(() => api(tb).menus.onShown.addListener("nope"), /Incorrect argument types/);
  });

  it("validates setPopup/getPopup/openPopup on both action buttons against browserAction.json and messageDisplayAction.json", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    // A global header setPopup answers only once every about:message has
    // painted, and the mail tab's is hidden while no message is displayed.
    tb.selectMessages([tb.addMessage().id]);
    const m = api(tb);
    for (const ns of ["browserAction", "messageDisplayAction"]) {
      // tNOTE's own calls.
      assert.equal(await m[ns].setPopup({ popup: "note.html?id=7" }), null);
      assert.equal(await m[ns].setPopup({ popup: "note.html" }), null);
      // "popup" is required (string or null); windowId is marked unsupported.
      assert.throws(() => m[ns].setPopup({}), new RegExp(`Property "popup" is required\\) for ${ns}\\.setPopup\\.`));
      assert.throws(() => m[ns].setPopup({ popup: 7 }), /Value 7 matches none of the allowed choices/);
      assert.throws(() => m[ns].setPopup("note.html"), new RegExp(`Incorrect argument types for ${ns}\\.setPopup\\.`));
      assert.throws(() => m[ns].setPopup({ popup: "note.html", windowId: 1 }), /Property "windowId" is unsupported by Firefox/);
      assert.throws(() => m[ns].setPopup({ popup: "note.html", tabId: -1 }), /Integer -1 is too small \(must be at least 0\)/);
      assert.throws(() => m[ns].getPopup({ windowId: 1 }), /Property "windowId" is unsupported by Firefox/);
      assert.throws(() => m[ns].openPopup({ windowId: "1" }), /Expected integer instead of "1"/);
    }
    assert.equal(tb.violations.length, 14, "every rejected call was recorded, and only those");
  });
});

describe("action button popups (model of ExtensionToolbarButtons.sys.mjs)", { skip }, () => {
  it("setPopup resolves against the caller and is global; getPopup reads it back; null restores the manifest's", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const m = api(tb);
    assert.equal(await m.browserAction.getPopup({}), BASE_URL + "note.html", "manifest default_popup, resolved");
    await m.browserAction.setPopup({ popup: "note.html?id=7" });
    assert.equal(await m.browserAction.getPopup({}), BASE_URL + "note.html?id=7");
    assert.equal(await m.browserAction.getPopup({ tabId: tb.mailTab.id }), BASE_URL + "note.html?id=7", "tabs inherit the global value");
    assert.equal(await m.messageDisplayAction.getPopup({}), BASE_URL + "note.html", "the other button is separate");
    await m.browserAction.setPopup({ popup: null });
    assert.equal(await m.browserAction.getPopup({}), BASE_URL + "note.html");
    // A page in a subfolder resolves against itself (:1006-1010).
    const sub = tb.createContext("sub page", "addon_child", BASE_URL + "pages/x.html").api;
    await sub.browserAction.setPopup({ popup: "note.html" });
    assert.equal(await m.browserAction.getPopup({}), BASE_URL + "pages/note.html");
    await assert.rejects(m.browserAction.setPopup({ popup: "note.html", tabId: 999 }), /Invalid tab ID: 999/);
  });

  it("a tab-specific popup wins over the global one for that tab only", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const m = api(tb);
    await m.browserAction.setPopup({ popup: "note.html?tab", tabId: tb.mailTab.id });
    await m.browserAction.setPopup({ popup: "note.html?global" });
    assert.equal(await m.browserAction.getPopup({ tabId: tb.mailTab.id }), BASE_URL + "note.html?tab");
    assert.equal(await m.browserAction.getPopup({}), BASE_URL + "note.html?global");
    const other = tb.addTab(tb.mainWindow.id, "content");
    assert.equal(await m.browserAction.getPopup({ tabId: other.id }), BASE_URL + "note.html?global");
  });

  it("openPopup opens the URL that was set when it was called, even if setPopup follows before it settles", async (t) => {
    // triggerAction reads the popup before it awaits the window's focus
    // (ExtensionToolbarButtons.sys.mjs:577-580, :601).
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    const m = api(tb);
    await m.browserAction.setPopup({ popup: "note.html?id=7" });
    const opened = m.browserAction.openPopup({ windowId: tb.mainWindow.id });
    const reset = m.browserAction.setPopup({ popup: "note.html" });
    assert.deepEqual(await Promise.all([opened, reset]), [true, null]);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=7");
    assert.equal(await m.browserAction.getPopup({}), BASE_URL + "note.html");
  });

  it("openPopup answers false without a popup URL, and a user click then opens nothing", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    const m = api(tb);
    await m.browserAction.setPopup({ popup: "" });
    assert.equal(await m.browserAction.openPopup({}), false, "requirePopupUrl (:1087-1089)");
    assert.equal(tb.clickActionButton("browserAction"), null);
    assert.equal(tb.popups.length, 0);
  });

  it("openPopup into a window without focus waits for it, and never settles if focus never comes", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    tb.config.windowFocusArrives = false;
    const second = tb.addWindow("normal");
    tb.addTab(second.id, "mail");
    let settled = false;
    api(tb).browserAction.openPopup({ windowId: second.id }).then(() => (settled = true));
    await flush();
    assert.equal(settled, false);
    assert.equal(tb.popups.length, 0);
  });

  it("a panel still open in the window is reused by openPopup, whatever the popup URL says", async (t) => {
    // ViewPopup.for(extension, window.top) (:605-607) is keyed by add-on and window, not by button.
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    const m = api(tb);
    assert.equal(await m.browserAction.openPopup({}), true);
    await m.browserAction.setPopup({ popup: "note.html?id=9" });
    assert.equal(await m.browserAction.openPopup({}), true);
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html");
    tb.dismissPopup(tb.popups[0]);
    assert.equal(await m.browserAction.openPopup({}), true);
    assert.equal(tb.popups.at(-1).url, BASE_URL + "note.html?id=9");
  });

  it("window.focus() in an extension page is recorded, not logged as unimplemented", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const page = tb.loadExtensionPage("note.html", { name: "focus check" });
    page.window.focus();
    page.document.getElementById("done").focus();
    assert.deepEqual(page.focusLog.slice(-2), ["window", "#done"]);
    assert.deepEqual(tb.consoleMessages.filter((m) => /Not implemented/.test(m.args.join(" "))), []);
  });
});

// A setter stores its value before its first await (setProperty,
// ExtensionToolbarButtons.sys.mjs:877-884) and answers after updateOnChange
// (:886), which waits for an animation frame in every window the button lives
// in (:796-804, :767-774); the header button waits in every about:message of
// those windows (ext-messageDisplayAction.js:105-113), shown or hidden.
describe("when setPopup answers (model of updateOnChange and animation frames)", { skip }, () => {
  /** Watches a promise without awaiting it, so a test can check it has not settled. */
  function track(promise) {
    const state = { settled: false, value: undefined };
    promise.then((v) => Object.assign(state, { settled: true, value: v }));
    return state;
  }

  it("with every document shown, it is stored at once and answers on the next turn", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.selectMessages([tb.addMessage().id]);
    const m = api(tb);
    const ba = track(m.browserAction.setPopup({ popup: "note.html?id=1" }));
    const mda = track(m.messageDisplayAction.setPopup({ popup: "note.html?id=1" }));
    assert.equal(tb.popupUrl("browserAction"), BASE_URL + "note.html", "not yet: the call is still on its way to the parent");
    await flush(1);
    assert.equal(tb.popupUrl("browserAction"), BASE_URL + "note.html?id=1");
    assert.equal(tb.popupUrl("messageDisplayAction"), BASE_URL + "note.html?id=1");
    await flush();
    assert.deepEqual([ba, mda], [{ settled: true, value: null }, { settled: true, value: null }]);
    assert.deepEqual(tb.pendingFrames(), []);
  });

  it("the header button's global setPopup never answers while another tab's about:message is hidden, but openPopup sees the value at once", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.config.popupLoads = false;
    const msg = tb.addMessage();
    tb.selectMessages([msg.id]);
    const other = tb.openMailTab({ background: true });
    const m = api(tb);
    const set = track(m.messageDisplayAction.setPopup({ popup: "note.html?id=1" }));
    const opened = track(m.messageDisplayAction.openPopup({ windowId: tb.mainWindow.id }));
    await flush();
    assert.deepEqual(opened, { settled: true, value: true });
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1", "openPopup, sent after setPopup, read the new value");
    await advance(tb, 60000);
    assert.equal(set.settled, false, "no answer while the other tab's about:message is hidden");
    assert.deepEqual(tb.pendingFrames(), [{ tabId: other.id }]);
    // The toolbar button waits for its window only, so it is not held up.
    const ba = track(m.browserAction.setPopup({ popup: "note.html" }));
    await flush();
    assert.equal(ba.settled, true);
    // Once that tab is selected and shows a message, its frame comes.
    tb.selectTab(other);
    tb.selectMessages([msg.id], { tab: other });
    await flush();
    assert.equal(set.settled, true);
  });

  it("the header button's global setPopup never answers while a second main window shows no message", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    tb.selectMessages([tb.addMessage().id]);
    const second = tb.openMainWindow();
    const set = track(api(tb).messageDisplayAction.setPopup({ popup: "note.html?id=1" }));
    await advance(tb, 60000);
    assert.equal(set.settled, false);
    assert.deepEqual(tb.pendingFrames(), [{ tabId: second.tab.id }]);
    assert.equal(tb.popupUrl("messageDisplayAction", tb.mainWindow.id), BASE_URL + "note.html?id=1", "stored all the same");
  });

  it("a minimized main window delays the toolbar button's global setPopup by the throttled frame time", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const second = tb.openMainWindow();
    tb.setWindowState(second.window, "minimized");
    assert.equal(tb.topWindowId, tb.mainWindow.id, "the first window is active again");
    const set = track(api(tb).browserAction.setPopup({ popup: "note.html?id=1" }));
    await flush();
    assert.equal(tb.popupUrl("browserAction"), BASE_URL + "note.html?id=1", "stored at once");
    assert.equal(set.settled, false);
    assert.deepEqual(tb.pendingFrames(), [{ windowId: second.window.id }]);
    await advance(tb, 999);
    assert.equal(set.settled, false);
    await advance(tb, 1);
    assert.equal(set.settled, true, "answered after throttledFrameMs (1000 ms) of fake time");
  });

  it("a minimized window that is restored paints on the next turn", async (t) => {
    const tb = worldWith();
    t.after(() => tb.dispose());
    const second = tb.openMainWindow();
    tb.setWindowState(second.window, "minimized");
    const set = track(api(tb).browserAction.setPopup({ popup: "note.html?id=1" }));
    await advance(tb, 500);
    assert.equal(set.settled, false);
    tb.setWindowState(second.window, "normal");
    await flush();
    assert.equal(set.settled, true);
    assert.equal(tb.windowInfo(second.window).state, "normal");
  });

  it("a tab-specific setPopup waits only for that tab, and only while it is selected", async (t) => {
    // updateOnChange(tab) repaints only the selected tab (:791-794,
    // ext-messageDisplayAction.js:131-145).
    const tb = worldWith();
    t.after(() => tb.dispose());
    const other = tb.openMailTab({ background: true });
    tb.openMainWindow(); // shows no message: would block a global header setPopup
    const m = api(tb);
    const unselected = track(m.messageDisplayAction.setPopup({ popup: "note.html?x", tabId: other.id }));
    const selectedHidden = track(m.messageDisplayAction.setPopup({ popup: "note.html?y", tabId: tb.mailTab.id }));
    await flush();
    assert.equal(unselected.settled, true, "an unselected tab is not repainted at all");
    assert.equal(selectedHidden.settled, false, "the selected tab's about:message is hidden (no message shown)");
    tb.selectMessages([tb.addMessage().id]);
    await flush();
    assert.equal(selectedHidden.settled, true);
  });

  it("hold() refuses setPopup, whose value the real parent stores as soon as it gets the call", () => {
    const tb = worldWith();
    try {
      assert.throws(() => tb.hold("browserAction.setPopup"), /not modelled/);
      assert.throws(() => tb.hold("messageDisplayAction.setPopup"), /not modelled/);
    } finally {
      tb.dispose();
    }
  });
});
