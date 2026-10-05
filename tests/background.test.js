"use strict";
// background.js, run unmodified in a vm context against the schema-checked fake.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { boot, pageApi, assertClean, tagsOf, popupText, warnings, advance, flush, skip, BASE_URL } = require("./harness/setup.js");

const GREEN = "#2E8B57";
const DEFAULT_TAGS = [
  { key: "$label1", tag: "Important", color: "#FF0000", ordinal: "" },
  { key: "$label2", tag: "Work", color: "#FF9900", ordinal: "" },
  { key: "$label3", tag: "Personal", color: "#009900", ordinal: "" },
  { key: "$label4", tag: "To Do", color: "#3333FF", ordinal: "" },
  { key: "$label5", tag: "Later", color: "#993399", ordinal: "" },
];
const USER_NOTE_TAG = { key: "note", tag: "Note", color: "#00AA00", ordinal: "" };
const THREE = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }, { subject: "Lunch?" }];
const MULTI_TITLE = "Add note (select one message)";
/** The fake's two folders (MailFolder.id). */
const INBOX = "account1://INBOX";
const ARCHIVES = "account1://Archives";
/**
 * What save() keeps next to a note for the All notes list (v0.5.0), with the
 * message's folder since v0.6.0; the fake's message n is dated 2026-10-01 09:0n UTC.
 */
const infoFor = (id, { subject = "Invoice 42", author = "Ann <ann@example.com>", mid = `msg${id}@example.com`, folderId = INBOX } = {}) => ({
  subject,
  author,
  date: Date.UTC(2026, 9, 1, 9, id),
  mid,
  folderId,
});
/** The info v0.5.0 wrote: no folder. */
const infoV050 = (id, opts) => {
  const { folderId, ...rest } = infoFor(id, opts);
  return rest;
};
/** The folder-scoped and the all-folders search background.js makes for a Message-ID (v0.6.0). */
const inFolder = (folderId, mid) => [{ folderId, headerMessageId: mid, messagesPerPage: 1 }];
const everywhere = (mid) => [{ headerMessageId: mid, messagesPerPage: 1 }];

const send = (tb, msg) => pageApi(tb).runtime.sendMessage(msg);
const argsOf = (tb, api) => tb.apiCalls(api).map((c) => c.args);
const editorCalls = (tb) =>
  tb.calls.filter((c) => /openPopup|windows\.create|tabs\.create/.test(c.api)).map((c) => [c.api, c.result]);
/** The manifest's popups, as Thunderbird stores them (resolved against the add-on). */
const POPUP_URL = BASE_URL + "note.html"; // header Note button
const LIST_URL = BASE_URL + "list.html"; // toolbar button (v0.5.0: All notes)
/** setPopup/openPopup calls on both action buttons, in order, from call index `from`. */
const actionCalls = (tb, from = 0) =>
  tb.calls.slice(from).filter((c) => /Action\.(setPopup|openPopup)$/.test(c.api)).map((c) => [c.api, c.args[0]]);
/** Selecting (v0.6.0) and the action-button calls, in the order made, from call index `from`. */
const openingCalls = (tb, from = 0) =>
  tb.calls
    .slice(from)
    .filter((c) => /^mailTabs\.setSelectedMessages$|Action\.(setPopup|openPopup)$/.test(c.api))
    .map((c) => (c.api === "mailTabs.setSelectedMessages" ? [c.api, ...c.args] : [c.api, c.args[0]]));
/** What each messageDisplay.getDisplayedMessage call answered: a message id, null, "rejected" or "pending". */
const displayedAnswers = (tb, from = 0) =>
  tb.calls
    .slice(from)
    .filter((c) => c.api === "messageDisplay.getDisplayedMessage")
    .map((c) => (c.rejected !== undefined ? "rejected" : c.result === undefined ? "pending" : c.result?.id ?? null));
/** "load" requests the editor pages sent, in order. */
const loadRequests = (tb) => tb.apiCalls("runtime.sendMessage").map((c) => c.args[0]).filter((m) => m.type === "load");
/** Each action button's popup now, read through the API as an add-on would. */
async function popupsNow(tb) {
  const api = pageApi(tb, "popup check");
  return { header: await api.messageDisplayAction.getPopup({}), toolbar: await api.browserAction.getPopup({}) };
}
const UNCHANGED = { header: POPUP_URL, toolbar: LIST_URL };
/** Notes the All notes list shows in a toolbar panel, as subject lines. */
const listSubjects = (popup) => [...popup.page.document.querySelectorAll("#list .subject")].map((e) => e.textContent);

function contentApi(tb, tab) {
  return tb.createContext(`content (tab ${tab.id})`, "content_child", "mailbox:///home/user/Inbox?number=1", {
    tab,
    sender: { tab: tb.tabInfo(tab), frameId: 0 },
  }).api;
}

describe("ensureTag (startup)", { skip }, () => {
  it("creates the green Note tag when it is missing", async (t) => {
    const { tb } = await boot(t);
    assert.deepEqual(argsOf(tb, "messages.tags.create"), [["mailnote", "Note", GREEN]]);
    assert.deepEqual(argsOf(tb, "messages.tags.update"), []);
    assert.deepEqual(tb.tags.at(-1), { key: "mailnote", tag: "Note", color: GREEN, ordinal: "" });
    assertClean(tb);
  });

  it("only updates the colour when the tag exists in another colour", async (t) => {
    const { tb } = await boot(t, { tags: [...DEFAULT_TAGS, { key: "mailnote", tag: "Note", color: "#FF0000", ordinal: "" }] });
    assert.deepEqual(argsOf(tb, "messages.tags.create"), []);
    assert.deepEqual(argsOf(tb, "messages.tags.update"), [["mailnote", { color: GREEN }]]);
    assert.equal(tb.tags.find((x) => x.key === "mailnote").color, GREEN);
    assertClean(tb);
  });

  it("leaves an already-green tag alone (colour compared case-insensitively)", async (t) => {
    const { tb } = await boot(t, { tags: [...DEFAULT_TAGS, { key: "mailnote", tag: "Note", color: "#2e8b57", ordinal: "" }] });
    assert.deepEqual(argsOf(tb, "messages.tags.create"), []);
    assert.deepEqual(argsOf(tb, "messages.tags.update"), []);
    assertClean(tb);
  });

  it("keeps a name the user gave the tag", async (t) => {
    const { tb } = await boot(t, { tags: [...DEFAULT_TAGS, { key: "mailnote", tag: "Context", color: GREEN, ordinal: "" }] });
    assert.equal(tb.tags.find((x) => x.key === "mailnote").tag, "Context");
    assertClean(tb);
  });

  it("starts cleanly when the user already has a tag named \"Note\" under another key", async (t) => {
    // ext-messages.js:2100-2101 rejects tags.create when any tag already has the
    // display name "Note". v0.4.0 names its own tag "tNOTE" in that case.
    const { tb } = await boot(t, { tags: [...DEFAULT_TAGS, USER_NOTE_TAG] });
    assert.deepEqual(tb.unhandled.map((e) => e.message), [], "startup ensureTag() rejected without a handler");
    assert.deepEqual(argsOf(tb, "messages.tags.create"), [["mailnote", "tNOTE", GREEN]]);
    assert.deepEqual(tb.apiCalls("messages.tags.create")[0].rejected, undefined, "tags.create succeeded");
    assert.deepEqual(tb.tags.find((x) => x.key === "note"), USER_NOTE_TAG, "the user's own Note tag is untouched");
    assert.deepEqual(tb.tags.find((x) => x.key === "mailnote"), { key: "mailnote", tag: "tNOTE", color: GREEN, ordinal: "" });
    assert.deepEqual(warnings(tb), []);
    assertClean(tb);
  });

  it("a tag set-up that fails at startup is logged, and the rest of startup still runs", async (t) => {
    const { tb } = await boot(t, { faults: { "messages.tags.list": new Error("tags unavailable") } });
    assert.deepEqual(tb.unhandled.map(String), []);
    assert.equal(warnings(tb).length, 1);
    assert.match(warnings(tb)[0], /could not set up the Note tag.*tags unavailable/);
    assert.ok(tb.menuItems.has("mail-note"), "menu item created");
    assert.equal(tb.displayScripts.length, 1, "display script registered");
    assertClean(tb);
  });
});

describe("context menu item", { skip }, () => {
  it("creates one message-list item titled Add note…", async (t) => {
    const { tb } = await boot(t);
    assert.deepEqual(argsOf(tb, "menus.create"), [[{ id: "mail-note", title: "Add note…", contexts: ["message_list"] }]]);
    const item = tb.menuItems.get("mail-note");
    assert.equal(item.enabled, true);
    assertClean(tb);
  });

  it("single message without a note: Add note…, enabled, menu refreshed", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    await tb.rightClick([msgs[0].id]);
    assert.deepEqual(argsOf(tb, "menus.update"), [["mail-note", { title: "Add note…", enabled: true }]]);
    assert.equal(tb.menuRefreshes, 1);
    assertClean(tb);
  });

  it("single message with a note: Edit note…", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, storage: { "note:msg2@example.com": "Chase Bob" } });
    await tb.rightClick([msgs[1].id]);
    assert.equal(tb.menuItems.get("mail-note").title, "Edit note…");
    assert.equal(tb.menuItems.get("mail-note").enabled, true);
    assertClean(tb);
  });

  it("several messages: disabled and titled \"Add note (select one message)\" (even if the first has a note)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, storage: { "note:msg1@example.com": "x" } });
    await tb.rightClick([msgs[0].id, msgs[1].id]);
    assert.deepEqual(argsOf(tb, "menus.update"), [["mail-note", { title: MULTI_TITLE, enabled: false }]]);
    assert.deepEqual(argsOf(tb, "storage.local.get"), [], "no note lookup for a multi-selection");
    assert.equal(tb.menuRefreshes, 1);
    await assert.rejects(tb.clickMenuItem("mail-note", [msgs[0].id, msgs[1].id]), /disabled/);
    assertClean(tb);
  });

  it("a collapsed thread (right-clicked as all of its messages) gets the same disabled item", async (t) => {
    // menus.onShown reports a collapsed thread as every message in it.
    const { tb, msgs } = await boot(t, { messages: THREE });
    await tb.rightClick(msgs.map((m) => m.id));
    const item = tb.menuItems.get("mail-note");
    assert.equal(item.title, MULTI_TITLE);
    assert.equal(item.enabled, false);
    assertClean(tb);
  });

  it("is enabled and titled Add note… again for a single message after a multi-selection", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    await tb.rightClick([msgs[0].id, msgs[1].id]);
    await tb.rightClick([msgs[2].id]);
    assert.equal(tb.menuItems.get("mail-note").enabled, true);
    assert.equal(tb.menuItems.get("mail-note").title, "Add note…");
    assertClean(tb);
  });

  it("does nothing when a menu is shown without its item", async (t) => {
    const { tb, msgs } = await boot(t);
    await Promise.all(tb.fire("menus.onShown", [{ menuIds: [], contexts: ["message_list"], editable: false, selectedMessages: tb.messageList([msgs[0].id]) }, tb.tabInfo(tb.mailTab)]));
    assert.deepEqual(argsOf(tb, "menus.update"), []);
    assertClean(tb);
  });

  it("finds the note of a message without Message-ID (fallback key)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: [{ subject: "No id", headerMessageId: "" }], storage: { "note:id:1": "x" } });
    await tb.rightClick([msgs[0].id]);
    assert.equal(tb.menuItems.get("mail-note").title, "Edit note…");
    assertClean(tb);
  });
});

describe("menu click: opening the editor", { skip }, () => {
  it("uses the message header panel when the right-clicked message is the one displayed", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    await flush(); // display.js's own request for the displayed message is done
    const from = tb.calls.length;
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    const shown = tb.calls.slice(from).filter((c) => c.api === "messageDisplay.getDisplayedMessage");
    assert.deepEqual(shown.map((c) => [c.args, c.result.id]), [[[tb.mailTab.id], msgs[0].id]]);
    // The header button's popup points at the right-clicked message for the
    // openPopup call only, and the toolbar button is never touched.
    assert.deepEqual(actionCalls(tb, from), [
      ["messageDisplayAction.setPopup", { popup: "note.html?id=1" }],
      ["messageDisplayAction.openPopup", { windowId: tb.mainWindow.id }],
      ["messageDisplayAction.setPopup", { popup: "note.html" }],
    ]);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [], "already displayed: the selection is left alone (v0.6.0)");
    assert.equal(tb.apiCalls("messageDisplayAction.openPopup")[0].result, true);
    assert.deepEqual(argsOf(tb, "tabs.create"), []);
    await flush();
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].kind, "messageDisplayAction");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1", "the panel opened the right-clicked message's URL");
    assert.deepEqual(loadRequests(tb), [{ type: "load", id: 1 }], "the editor asked for that message by id");
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    assert.deepEqual(await popupsNow(tb), UNCHANGED, "both buttons are back to their own pages");
    assertClean(tb);
  });

  it("selects the right-clicked message when another is displayed, then opens the header panel under it (v0.6.0)", async (t) => {
    // v0.5.0 edited Lunch? in the toolbar panel at the top right, away from
    // the message, because the header panel hangs off the displayed message
    // (Invoice 42). v0.6.0 selects Lunch? first, as clicking it would, so the
    // header panel opens under Lunch? itself.
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    await flush();
    const from = tb.calls.length;
    const held = tb.hold("messageDisplayAction.openPopup");
    const clicked = tb.clickMenuItem("mail-note", [msgs[2].id]);
    await flush();
    // Paused at the header openPopup: Lunch? is the message on display now.
    assert.deepEqual(tb.displayedIds(tb.mailTab), [3], "the header panel is asked for while Lunch? is displayed");
    assert.equal(tb.messagePaneShowsOne(tb.mainWindow.id), true);
    held.release();
    await clicked;
    assert.deepEqual(openingCalls(tb, from), [
      ["mailTabs.setSelectedMessages", tb.mailTab.id, [3]],
      ["messageDisplayAction.setPopup", { popup: "note.html?id=3" }],
      ["messageDisplayAction.openPopup", { windowId: tb.mainWindow.id }],
      ["messageDisplayAction.setPopup", { popup: "note.html" }],
    ]);
    // Asked before selecting (Invoice 42), and after (Lunch?); the third answer
    // is display.js's own request for the newly displayed message.
    assert.deepEqual(displayedAnswers(tb, from).sort(), [1, 3, 3].sort());
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]], "the toolbar panel is not used");
    assert.deepEqual(tb.mailTab.selected, [3]);
    await flush();
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].kind, "messageDisplayAction");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
    assert.deepEqual(loadRequests(tb), [{ type: "load", id: 3 }]);
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assert.equal(tb.clock.now(), Date.UTC(2026, 9, 5, 8, 0, 0), "no waiting: the display finished at once");
    assertClean(tb);
  });

  it("selects the right-clicked message when the reading pane shows none, then opens the header panel under it (v0.6.0)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    // Right-clicking an unselected message leaves the pane empty.
    await tb.clickMenuItem("mail-note", [msgs[1].id]);
    assert.deepEqual(openingCalls(tb), [
      ["mailTabs.setSelectedMessages", tb.mailTab.id, [2]],
      ["messageDisplayAction.setPopup", { popup: "note.html?id=2" }],
      ["messageDisplayAction.openPopup", { windowId: tb.mainWindow.id }],
      ["messageDisplayAction.setPopup", { popup: "note.html" }],
    ]);
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]]);
    assert.deepEqual(argsOf(tb, "browserAction.setPopup"), [], "the toolbar button is left alone");
    await flush();
    assert.equal(tb.popups[0].kind, "messageDisplayAction");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=2");
    assert.equal(popupText(tb.popups[0]).subject, "Quote for racks");
    assert.equal(tb.displayPages.at(-1).msgId, 2, "Quote for racks is on display under the panel");
    assertClean(tb);
  });

  it("with the reading pane hidden, selects the right-clicked message and edits it in the toolbar panel at once", async (t) => {
    // Nothing can be displayed, so there is no header panel; the toolbar
    // panel is the way (v0.6.0 still selects the message, as a click would).
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[2].id]);
    assert.deepEqual(openingCalls(tb), [
      ["mailTabs.setSelectedMessages", tb.mailTab.id, [3]],
      ["browserAction.setPopup", { popup: "note.html?id=3" }],
      ["browserAction.openPopup", { windowId: tb.mainWindow.id }],
      ["browserAction.setPopup", { popup: "list.html" }],
    ]);
    assert.deepEqual(displayedAnswers(tb), [null, null], "nothing is displayed before or after selecting");
    assert.deepEqual(editorCalls(tb), [["browserAction.openPopup", true]], "the header panel is not tried");
    assert.deepEqual(tb.mailTab.selected, [3]);
    assert.equal(tb.clock.now(), Date.UTC(2026, 9, 5, 8, 0, 0), "no 2 s wait: a hidden pane answers null at once");
    await flush();
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assertClean(tb);
  });

  it("uses the toolbar button panel when the reading pane is hidden, even for the selected message", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    assert.deepEqual(displayedAnswers(tb), [null, null]);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [1]]]);
    assert.deepEqual(editorCalls(tb), [["browserAction.openPopup", true]]);
    assert.deepEqual(argsOf(tb, "messageDisplayAction.setPopup"), []);
    await flush();
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    assertClean(tb);
  });

  it("when selecting fails, logs it and edits the right-clicked message in the toolbar panel, not under the other message", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    await flush();
    tb.faults["mailTabs.setSelectedMessages"] = new Error("view not ready");
    await tb.clickMenuItem("mail-note", [msgs[2].id]);
    assert.deepEqual(openingCalls(tb).map((c) => c[0]), [
      "mailTabs.setSelectedMessages",
      "browserAction.setPopup",
      "browserAction.openPopup",
      "browserAction.setPopup",
    ]);
    assert.deepEqual(warnings(tb), ["tNOTE: Error: view not ready"]);
    assert.deepEqual(tb.mailTab.selected, [1], "Invoice 42 is still the one displayed");
    await flush();
    assert.equal(tb.popups[0].kind, "browserAction");
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assertClean(tb);
  });

  it("a display that has not finished 2 s after selecting falls back to the toolbar panel", async (t) => {
    // background.js waits up to 2 s for the newly selected message to display.
    const { tb, msgs } = await boot(t, { messages: THREE, config: { displayLoads: false } });
    const clicked = tb.clickMenuItem("mail-note", [msgs[2].id]);
    await flush();
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [3]]]);
    assert.deepEqual(displayedAnswers(tb), [null, "pending"], "selected and displaying, not finished");
    await advance(tb, 1999);
    assert.deepEqual(editorCalls(tb), [], "still waiting at 1999 ms");
    await advance(tb, 1);
    assert.deepEqual(editorCalls(tb), [["browserAction.openPopup", true]], "toolbar panel at 2000 ms, header panel not tried");
    await clicked;
    await flush();
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    tb.finishMessageLoad();
    await advance(tb, 2000);
    assert.equal(tb.popups.length, 1, "the display finishing later opens nothing more");
    assertClean(tb);
  });

  it("a display that finishes within 2 s of selecting gets the header panel", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, config: { displayLoads: false } });
    const clicked = tb.clickMenuItem("mail-note", [msgs[2].id]);
    await flush();
    await advance(tb, 1500); // longer than the 1 s allowed before selecting
    assert.deepEqual(editorCalls(tb), []);
    tb.finishMessageLoad();
    await flush();
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]]);
    await clicked;
    await advance(tb, 1000);
    assert.equal(tb.popups.length, 1, "the 2 s timer firing later changes nothing");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assertClean(tb);
  });

  it("falls back to the toolbar button panel when the header panel call rejects", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    tb.faults["messageDisplayAction.openPopup"] = new Error("panel failed");
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    assert.equal(tb.apiCalls("browserAction.openPopup").length, 1);
    await flush();
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1");
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assertClean(tb);
  });

  it("falls back to the toolbar button panel when asking for the displayed message fails", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    await flush(); // let display.js finish its own request first
    const pagesBefore = tb.displayPages.length;
    tb.faults["messageDisplay.getDisplayedMessage"] = new Error("not ready");
    const from = tb.calls.length;
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    // Not known to be displayed, so v0.6.0 selects it (again) and asks again.
    assert.deepEqual(openingCalls(tb).map((c) => c[0]), ["mailTabs.setSelectedMessages", "browserAction.setPopup", "browserAction.openPopup", "browserAction.setPopup"]);
    assert.deepEqual(editorCalls(tb), [["browserAction.openPopup", true]]);
    await flush();
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    // Selecting the displayed message displays it again (about3Pane.js:5300-5343,
    // aboutMessage.js:220-260 has no same-message shortcut), so display.js runs
    // again, and its own forDisplay request meets the same fault. Since v0.6.1
    // display.js catches that (v0.6.0 left an unhandled rejection in the
    // message's content script): no note bar, and nothing unhandled anywhere.
    assert.equal(tb.displayPages.length, pagesBefore + 1, "the message was displayed again");
    const again = tb.displayPages.at(-1);
    const asked = tb.calls.slice(from).filter((c) => c.api === "runtime.sendMessage" && c.context === again.ctx.name);
    assert.deepEqual(asked.map((c) => [c.args[0], c.rejected]), [[{ type: "forDisplay" }, "not ready"]], "its forDisplay request failed");
    assert.equal(again.shadowRoots.length, 0, "so it shows no bar");
    assert.deepEqual(tb.unhandled.map(String), []);
    assertClean(tb);
  });

  it("opens the editor as a tab in the same window when neither panel can open", async (t) => {
    // v0.6.0 selects the message first, so the header panel would open; with
    // the header button removed too, neither panel can.
    const { tb, msgs } = await boot(t, { messages: THREE, config: { browserActionButton: false, messageDisplayActionButton: false } });
    await tb.clickMenuItem("mail-note", [msgs[2].id]);
    // Both panels were tried with this message's URL, could not open, and
    // their popups were still put back.
    assert.deepEqual(openingCalls(tb), [
      ["mailTabs.setSelectedMessages", tb.mailTab.id, [3]],
      ["messageDisplayAction.setPopup", { popup: "note.html?id=3" }],
      ["messageDisplayAction.openPopup", { windowId: tb.mainWindow.id }],
      ["messageDisplayAction.setPopup", { popup: "note.html" }],
      ["browserAction.setPopup", { popup: "note.html?id=3" }],
      ["browserAction.openPopup", { windowId: tb.mainWindow.id }],
      ["browserAction.setPopup", { popup: "list.html" }],
    ]);
    assert.equal(tb.apiCalls("messageDisplayAction.openPopup")[0].result, false);
    assert.equal(tb.apiCalls("browserAction.openPopup")[0].result, false);
    assert.deepEqual(argsOf(tb, "tabs.create"), [[{ url: "note.html?id=3", windowId: tb.mainWindow.id }]]);
    assert.deepEqual(argsOf(tb, "windows.create"), []);
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    await flush();
    const editor = tb.popups.find((p) => p.kind === "tab");
    assert.equal(editor.url, BASE_URL + "note.html?id=3");
    assert.equal(editor.windowId, tb.mainWindow.id);
    const tab = tb.tabs.get(editor.tabId);
    assert.equal(tab.type, "content");
    assert.equal(tab.active, true, "the editor tab is selected");
    assert.equal(tb.mailTab.active, false);
    assert.equal(popupText(editor).subject, "Lunch?");
    // The page puts the cursor in its text box and asks for nothing else.
    // v0.4.1 also called window.focus(), which real Thunderbird showed does
    // not give a content tab keyboard focus; v0.4.2 dropped it and accepts
    // that this rare last-resort editor opens without keyboard focus. (The
    // fake does not model keyboard focus between the window and a tab.)
    assert.deepEqual(editor.page.focusLog, ["#text"]);
    assert.equal(editor.page.document.activeElement, editor.page.document.getElementById("text"));

    // Done closes the tab and returns to the message list.
    editor.page.document.getElementById("text").value = "Booked";
    editor.page.document.getElementById("done").click();
    await flush();
    assert.equal(tb.storage.get("note:msg3@example.com"), "Booked");
    assert.equal(editor.page.closed, true);
    assert.equal(tb.tabs.has(editor.tabId), false, "editor tab closed");
    assert.equal(tb.mailTab.active, true, "mail tab selected again");
    assertClean(tb);
  });

  it("never opens a separate window, so focus-stealing prevention (Cinnamon/X11) cannot put the editor behind Thunderbird", async (t) => {
    const { tb, msgs } = await boot(t, {
      messages: THREE,
      config: { browserActionButton: false, messageDisplayActionButton: false, windowFocusArrives: false },
    });
    let done = false;
    tb.clickMenuItem("mail-note", [msgs[0].id]).then(() => (done = true));
    await flush();
    assert.equal(done, true, "onClicked finished");
    assert.deepEqual(argsOf(tb, "windows.create"), []);
    assert.equal(tb.windows.size, 1, "no new window");
    const editor = tb.popups.at(-1);
    assert.equal(editor.kind, "tab");
    assert.equal(editor.windowId, tb.topWindowId, "editor is in the focused window");
    assert.equal(tb.tabs.get(editor.tabId).active, true);
    assert.equal(popupText(editor).subject, "Invoice 42");
    assertClean(tb);
  });

  it("ignores a click that carries no selected messages", async (t) => {
    const { tb } = await boot(t);
    await Promise.all(tb.fire("menus.onClicked", [{ menuItemId: "mail-note", editable: false, modifiers: [] }, tb.tabInfo(tb.mailTab)]));
    assert.deepEqual(editorCalls(tb), []);
    assert.deepEqual(openingCalls(tb), [], "nothing selected, neither button's popup is touched");
    assertClean(tb);
  });

  it("a click without a tab (menus.onClicked's tab is optional) opens the toolbar panel and selects nothing", async (t) => {
    // menus.json lists onClicked's tab parameter as optional; background.js
    // guards every use of it. Nothing can be selected or displayed then.
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    await flush();
    const from = tb.calls.length;
    const info = { menuItemId: "mail-note", editable: false, modifiers: [], selectedMessages: tb.messageList([msgs[2].id]) };
    await Promise.all(tb.fire("menus.onClicked", [info]));
    assert.deepEqual(displayedAnswers(tb, from), [], "no tab to ask about");
    assert.deepEqual(openingCalls(tb, from), [
      ["browserAction.setPopup", { popup: "note.html?id=3" }],
      ["browserAction.openPopup", { windowId: undefined }],
      ["browserAction.setPopup", { popup: "list.html" }],
    ]);
    assert.deepEqual(tb.mailTab.selected, [1]);
    await flush();
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assertClean(tb);
  });

  it("ignores a click that carries several messages", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    const info = { menuItemId: "mail-note", editable: false, modifiers: [], selectedMessages: tb.messageList([msgs[0].id, msgs[1].id]) };
    await Promise.all(tb.fire("menus.onClicked", [info, tb.tabInfo(tb.mailTab)]));
    assert.deepEqual(editorCalls(tb), []);
    assert.deepEqual(openingCalls(tb), [], "nothing selected, neither button's popup is touched");
    assertClean(tb);
  });

  it("a header panel that closed before loading does not redirect the next editor to the old message", async (t) => {
    // v0.4.0 held the right-clicked id until a "load" took it. A panel that
    // opened (openPopup -> true) but was dismissed before note.js ran left it
    // behind for the next button click. v0.4.1 hands the id over in the panel's
    // URL, so no time needs to pass at all.
    const { tb, msgs } = await boot(t, { messages: THREE, config: { popupLoads: false } });
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    await flush();
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1");
    tb.dismissPopup(tb.popups[0]);
    tb.config.popupLoads = true;
    tb.selectMessages([msgs[2].id]);
    const popup = tb.clickActionButton("messageDisplayAction");
    assert.equal(popup.url, POPUP_URL, "a button click opens plain note.html");
    await flush();
    assert.deepEqual(loadRequests(tb), [{ type: "load", id: null }]);
    assert.equal(popupText(popup).subject, "Lunch?", "editor should show the displayed message");
    assertClean(tb);
  });

  it("a toolbar panel that never loaded does not redirect later header or toolbar clicks, with no time passing", async (t) => {
    // v0.5.0: the toolbar button's own page is the All notes list. v0.6.0
    // uses the toolbar panel only while the reading pane is hidden.
    const { tb, msgs } = await boot(t, { messages: THREE, config: { popupLoads: false } });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[2].id]); // toolbar panel for Lunch?, never loads
    await flush();
    assert.equal(tb.popups[0].kind, "browserAction");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
    tb.dismissPopup(tb.popups[0]);
    tb.config.popupLoads = true;
    // The user shows the reading pane again and clicks Invoice 42.
    tb.setMessagePaneVisible(true);
    tb.selectMessages([msgs[0].id]);
    await flush();
    const header = tb.clickActionButton("messageDisplayAction");
    await flush();
    assert.equal(popupText(header).subject, "Invoice 42", "the displayed message, not the stale right-click");
    tb.dismissPopup(header);
    const toolbar = tb.clickActionButton("browserAction");
    await flush();
    assert.equal(toolbar.url, LIST_URL, "the list, not the stale right-click's editor");
    assert.equal(toolbar.page.document.getElementById("status").textContent, "No notes yet. Right-click a message and choose Add note…");
    assert.deepEqual(loadRequests(tb), [{ type: "load", id: null }], "only the header editor asked for a message");
    assert.equal(tb.clock.now(), Date.UTC(2026, 9, 5, 8, 0, 0), "no fake time passed");
    assertClean(tb);
  });
});

describe("right-click hands the message to the panel in its URL (v0.4.1)", { skip }, () => {
  it("the panel's page is note.html?id=<right-clicked>, whichever button carries it", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[1].id]);
    await tb.clickMenuItem("mail-note", [msgs[1].id]); // displayed: header panel
    await flush();
    tb.setMessagePaneVisible(false);
    await tb.clickMenuItem("mail-note", [msgs[2].id]); // reading pane hidden: toolbar panel (rolls the first one up)
    await flush();
    assert.deepEqual(
      tb.popups.map((p) => [p.kind, p.page.window.location.href, popupText(p).subject]),
      [
        ["messageDisplayAction", BASE_URL + "note.html?id=2", "Quote for racks"],
        ["browserAction", BASE_URL + "note.html?id=3", "Lunch?"],
      ]
    );
    assert.deepEqual(loadRequests(tb), [
      { type: "load", id: 2 },
      { type: "load", id: 3 },
    ]);
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assertClean(tb);
  });

  for (const [kind, paneHidden, reset] of [
    ["browserAction", true, "list.html"],
    ["messageDisplayAction", false, "note.html"],
  ]) {
    it(`the ${kind} popup stays pointed at the message until openPopup has answered, then goes back`, async (t) => {
      // Thunderbird reads the popup URL when openPopup starts
      // (ExtensionToolbarButtons.sys.mjs:577-580), so the reset must not land
      // before that call is answered. The header panel is used for a message
      // v0.6.0 has just selected, the toolbar panel while the pane is hidden.
      const { tb, msgs } = await boot(t, { messages: THREE });
      if (paneHidden) tb.setMessagePaneVisible(false);
      const held = tb.hold(`${kind}.openPopup`);
      const clicked = tb.clickMenuItem("mail-note", [msgs[2].id]);
      await flush();
      assert.deepEqual(actionCalls(tb), [
        [`${kind}.setPopup`, { popup: "note.html?id=3" }],
        [`${kind}.openPopup`, { windowId: tb.mainWindow.id }],
      ]);
      assert.equal(tb.popupUrl(kind), BASE_URL + "note.html?id=3", "still pointed at the message");
      assert.equal(tb.popups.length, 0);
      held.release();
      await clicked;
      await flush();
      assert.deepEqual(actionCalls(tb).at(-1), [`${kind}.setPopup`, { popup: reset }]);
      assert.equal(actionCalls(tb).length, 3);
      assert.equal(tb.popups[0].kind, kind);
      assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
      assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
      assert.deepEqual(await popupsNow(tb), UNCHANGED);
      assertClean(tb);
    });
  }

  it("both popups are put back when the header openPopup rejects and the toolbar one returns false", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, config: { browserActionButton: false } });
    tb.selectMessages([msgs[0].id]);
    tb.faults["messageDisplayAction.openPopup"] = new Error("panel failed");
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    assert.deepEqual(actionCalls(tb), [
      ["messageDisplayAction.setPopup", { popup: "note.html?id=1" }],
      ["messageDisplayAction.openPopup", { windowId: tb.mainWindow.id }],
      ["messageDisplayAction.setPopup", { popup: "note.html" }],
      ["browserAction.setPopup", { popup: "note.html?id=1" }],
      ["browserAction.openPopup", { windowId: tb.mainWindow.id }],
      ["browserAction.setPopup", { popup: "list.html" }],
    ]);
    assert.equal(tb.apiCalls("messageDisplayAction.openPopup")[0].rejected, "panel failed");
    assert.equal(tb.apiCalls("browserAction.openPopup")[0].result, false);
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assert.deepEqual(argsOf(tb, "tabs.create"), [[{ url: "note.html?id=1", windowId: tb.mainWindow.id }]]);
    assertClean(tb);
  });

  it("the header popup is put back when its openPopup returns false (header button removed)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, config: { messageDisplayActionButton: false } });
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    assert.equal(tb.apiCalls("messageDisplayAction.openPopup")[0].result, false);
    assert.deepEqual(argsOf(tb, "messageDisplayAction.setPopup"), [[{ popup: "note.html?id=1" }], [{ popup: "note.html" }]]);
    await flush();
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].kind, "browserAction");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1");
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assertClean(tb);
  });

  it("a toolbar click right after a right-click opens the All notes list, not the right-clicked message's editor (reading pane hidden)", async (t) => {
    // Until v0.4.2 the toolbar button opened the editor for the selected
    // message; since v0.5.0 its own page is the list, and a right-click only
    // borrows it for the one openPopup call.
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[2].id]);
    await flush();
    assert.equal(tb.popups[0].kind, "browserAction");
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assert.deepEqual(tb.mailTab.selected, [3], "v0.6.0 selects the right-clicked message even with the pane hidden");
    tb.popups[0].page.document.getElementById("text").value = "Book a table";
    tb.popups[0].page.document.getElementById("done").click();
    await flush();
    assert.equal(tb.popups[0].page.closed, true);
    const toolbar = tb.clickActionButton("browserAction");
    await flush();
    assert.equal(toolbar.url, LIST_URL);
    assert.deepEqual(loadRequests(tb), [{ type: "load", id: 3 }], "the list asks for no editor message");
    assert.deepEqual(listSubjects(toolbar), ["Lunch?"], "the list shows the note just added");
    assertClean(tb);
  });

  it("background.js keeps no right-click state between clicks", async (t) => {
    // White-box guard against the v0.4.0 "pending" hand-over coming back.
    const { tb, msgs } = await boot(t, { messages: THREE });
    await tb.clickMenuItem("mail-note", [msgs[2].id]);
    assert.equal(tb.bg("typeof pending"), "undefined");
    assert.equal(tb.bg("typeof PENDING_MS"), "undefined");
  });
});

describe("setPopup is not awaited, so a stalled answer cannot hold up the editor (v0.4.2)", { skip }, () => {
  // A global setPopup is stored as soon as the parent takes the call, before
  // the openPopup sent after it (ExtensionToolbarButtons.sys.mjs:877-884), but
  // answers only after an animation frame in every window the button lives in,
  // and for the header button in every about:message, hidden ones included
  // (:785-805, :767-774, ext-messageDisplayAction.js:105-113). A hidden
  // about:message never paints; a minimized window paints late. v0.4.1 awaited
  // both setPopup calls, so "Add note…" did nothing while another tab or window
  // showed no message, and the toolbar panel waited for a minimized window.
  const START = Date.UTC(2026, 9, 5, 8, 0, 0);
  /** Starts a menu click without awaiting it, so a stall fails an assertion instead of hanging the test. */
  function startClick(tb, id, opts) {
    const state = { finished: false };
    tb.clickMenuItem("mail-note", [id], opts).then(() => (state.finished = true));
    return state;
  }
  /** Whether each setPopup call of a button has been answered (null) or is still waiting (undefined). */
  const setPopupAnswers = (tb, kind) => tb.apiCalls(`${kind}.setPopup`).map((c) => c.result);

  it("Add note… opens the header panel at once while another tab's message pane is hidden", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    const other = tb.openMailTab({ background: true }); // shows no message: its about:message is hidden
    const click = startClick(tb, msgs[0].id);
    await flush();
    assert.equal(click.finished, true, "the menu click handler finished");
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]]);
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].kind, "messageDisplayAction");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1");
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    // The stall is real: neither header setPopup has answered.
    assert.deepEqual(setPopupAnswers(tb, "messageDisplayAction"), [undefined, undefined]);
    assert.deepEqual(tb.pendingFrames(), [{ tabId: other.id }, { tabId: other.id }]);
    assert.deepEqual(await popupsNow(tb), UNCHANGED, "the header popup is back to plain note.html all the same");
    assert.equal(tb.clock.now(), START, "no fake time passed");
    assertClean(tb);
  });

  it("Add note… opens the header panel at once while a second main window shows no message", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.openMainWindow();
    tb.selectMessages([msgs[1].id]); // in the first window
    const click = startClick(tb, msgs[1].id);
    await flush();
    assert.equal(click.finished, true);
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]]);
    assert.equal(tb.popups[0].windowId, tb.mainWindow.id);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=2");
    assert.equal(popupText(tb.popups[0]).subject, "Quote for racks");
    assert.deepEqual(setPopupAnswers(tb, "messageDisplayAction"), [undefined, undefined]);
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assertClean(tb);
  });

  it("Add note… on a message not on display selects it and opens the header panel at once while another tab's message pane is hidden (v0.6.0)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    const other = tb.openMailTab({ background: true });
    const click = startClick(tb, msgs[2].id);
    await flush();
    assert.equal(click.finished, true);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [3]]]);
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]]);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assert.deepEqual(setPopupAnswers(tb, "messageDisplayAction"), [undefined, undefined]);
    assert.deepEqual(tb.pendingFrames(), [{ tabId: other.id }, { tabId: other.id }]);
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assert.equal(tb.clock.now(), START);
    assertClean(tb);
  });

  it("the toolbar panel opens at once while a second main window is minimized", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    const second = tb.openMainWindow();
    tb.setWindowState(second.window, "minimized");
    tb.setMessagePaneVisible(false); // v0.6.0: the toolbar panel is for a hidden reading pane
    const click = startClick(tb, msgs[2].id);
    await flush();
    assert.equal(click.finished, true);
    assert.deepEqual(editorCalls(tb), [["browserAction.openPopup", true]]);
    assert.equal(tb.popups[0].kind, "browserAction");
    assert.equal(tb.popups[0].windowId, tb.mainWindow.id);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=3");
    assert.equal(popupText(tb.popups[0]).subject, "Lunch?");
    assert.equal(tb.clock.now(), START, "opened with no fake time passing");
    assert.deepEqual(setPopupAnswers(tb, "browserAction"), [undefined, undefined], "both still wait for the minimized window");
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    // When the minimized window finally paints, the answers change nothing.
    await advance(tb, 1000);
    assert.deepEqual(setPopupAnswers(tb, "browserAction"), [null, null]);
    assert.equal(tb.popups.length, 1);
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assertClean(tb);
  });

  it("the toolbar panel is tried at once when the header panel cannot open while another tab's message pane is hidden", async (t) => {
    // The header setPopup calls never answer here, so v0.4.1 never got past
    // the header attempt to the toolbar button.
    const { tb, msgs } = await boot(t, { messages: THREE, config: { messageDisplayActionButton: false } });
    tb.selectMessages([msgs[0].id]);
    tb.openMailTab({ background: true });
    const click = startClick(tb, msgs[0].id);
    await flush();
    assert.equal(click.finished, true);
    assert.deepEqual(editorCalls(tb), [
      ["messageDisplayAction.openPopup", false],
      ["browserAction.openPopup", true],
    ]);
    assert.deepEqual(setPopupAnswers(tb, "messageDisplayAction"), [undefined, undefined]);
    assert.equal(tb.popups[0].kind, "browserAction");
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1");
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    assertClean(tb);
  });

  it("with no setPopup ever answering, both popups are still put back and each later click opens the right message", async (t) => {
    // A second main window that shows no message (header answers never come)
    // and is minimized (toolbar answers wait for a frame that never comes
    // while no fake time passes).
    const { tb, msgs } = await boot(t, { messages: THREE });
    const second = tb.openMainWindow();
    tb.setWindowState(second.window, "minimized");
    tb.selectMessages([msgs[0].id]);
    const first = startClick(tb, msgs[0].id); // displayed: header panel
    await flush();
    tb.setMessagePaneVisible(false);
    const next = startClick(tb, msgs[2].id); // reading pane hidden: toolbar panel (rolls the first one up)
    await flush();
    assert.deepEqual([first.finished, next.finished], [true, true]);
    assert.deepEqual(
      tb.popups.map((p) => [p.kind, p.url, popupText(p).subject]),
      [
        ["messageDisplayAction", BASE_URL + "note.html?id=1", "Invoice 42"],
        ["browserAction", BASE_URL + "note.html?id=3", "Lunch?"],
      ]
    );
    assert.deepEqual(actionCalls(tb), [
      ["messageDisplayAction.setPopup", { popup: "note.html?id=1" }],
      ["messageDisplayAction.openPopup", { windowId: tb.mainWindow.id }],
      ["messageDisplayAction.setPopup", { popup: "note.html" }],
      ["browserAction.setPopup", { popup: "note.html?id=3" }],
      ["browserAction.openPopup", { windowId: tb.mainWindow.id }],
      ["browserAction.setPopup", { popup: "list.html" }],
    ]);
    assert.deepEqual([...setPopupAnswers(tb, "messageDisplayAction"), ...setPopupAnswers(tb, "browserAction")], [undefined, undefined, undefined, undefined]);
    assert.deepEqual(await popupsNow(tb), UNCHANGED);
    // A user click on either button now opens its own page: the header button
    // plain note.html (the displayed message), the toolbar button the list.
    // The user shows the reading pane again and clicks Invoice 42.
    tb.dismissPopup(tb.popups[1]);
    tb.setMessagePaneVisible(true);
    tb.selectMessages([msgs[0].id]);
    await flush();
    const header = tb.clickActionButton("messageDisplayAction");
    await flush();
    assert.equal(header.url, POPUP_URL);
    assert.equal(popupText(header).subject, "Invoice 42");
    tb.dismissPopup(header);
    const toolbar = tb.clickActionButton("browserAction");
    await flush();
    assert.equal(toolbar.url, LIST_URL);
    assert.equal(toolbar.page.document.getElementById("search"), toolbar.page.document.activeElement, "the list page ran");
    assert.equal(tb.clock.now(), START);
    assertClean(tb);
  });

  it("setPopup rejections are logged, and every fallback still runs, ending in the editor tab", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, config: { browserActionButton: false } });
    tb.selectMessages([msgs[0].id]);
    tb.faults["messageDisplayAction.setPopup"] = new Error("header popup refused");
    tb.faults["messageDisplayAction.openPopup"] = new Error("panel failed");
    tb.faults["browserAction.setPopup"] = new Error("toolbar popup refused");
    const click = startClick(tb, msgs[0].id);
    await flush();
    assert.equal(click.finished, true);
    assert.deepEqual(actionCalls(tb), [
      ["messageDisplayAction.setPopup", { popup: "note.html?id=1" }],
      ["messageDisplayAction.openPopup", { windowId: tb.mainWindow.id }],
      ["messageDisplayAction.setPopup", { popup: "note.html" }],
      ["browserAction.setPopup", { popup: "note.html?id=1" }],
      ["browserAction.openPopup", { windowId: tb.mainWindow.id }],
      ["browserAction.setPopup", { popup: "list.html" }],
    ]);
    assert.deepEqual(argsOf(tb, "tabs.create"), [[{ url: "note.html?id=1", windowId: tb.mainWindow.id }]]);
    const editor = tb.popups.find((p) => p.kind === "tab");
    assert.equal(popupText(editor).subject, "Invoice 42", "the editor tab carries the id itself");
    assert.deepEqual(warnings(tb).sort(), [
      "tNOTE: Error: header popup refused",
      "tNOTE: Error: header popup refused",
      "tNOTE: Error: toolbar popup refused",
      "tNOTE: Error: toolbar popup refused",
    ]);
    assertClean(tb); // includes: no unhandled rejections
  });

  it("a rejected header setPopup is logged and the header panel still opens on the displayed message", async (t) => {
    // The header panel is only used when the right-clicked message is the one
    // displayed, so plain note.html shows the same message.
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[1].id]);
    tb.faults["messageDisplayAction.setPopup"] = new Error("header popup refused");
    const click = startClick(tb, msgs[1].id);
    await flush();
    assert.equal(click.finished, true);
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]]);
    assert.equal(tb.popups[0].url, POPUP_URL, "the id could not be handed over");
    assert.equal(popupText(tb.popups[0]).subject, "Quote for racks");
    assert.equal(warnings(tb).length, 2);
    assertClean(tb);
  });
});

describe("a slow or stalled message display does not hold up the editor (v0.4.1)", { skip }, () => {
  // getDisplayedMessage waits for about:message to finish displaying
  // (ext-messageDisplay.js:205-231); background.js gives it 1 s.
  it("control: in the fake, getDisplayedMessage really waits while the display has not finished", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id], { loaded: false });
    let settled = false;
    pageApi(tb).messageDisplay.getDisplayedMessage(tb.mailTab.id).then(() => (settled = true));
    await advance(tb, 60000);
    assert.equal(settled, false);
    tb.finishMessageLoad();
    await flush();
    assert.equal(settled, true);
  });

  it("a right-click on a message whose display never finishes opens the toolbar panel after 1 s, plus 2 s after selecting it again (v0.6.0)", async (t) => {
    // Not known to be displayed after 1 s, so v0.6.0 selects it (which starts
    // displaying it again, and that stalls too) and waits up to 2 s more.
    const { tb, msgs } = await boot(t, { messages: THREE, config: { displayLoads: false } });
    tb.selectMessages([msgs[0].id], { loaded: false });
    const clicked = tb.clickMenuItem("mail-note", [msgs[0].id]);
    await advance(tb, 999);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [], "still waiting at 999 ms");
    await advance(tb, 1);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [1]]], "selected at 1000 ms");
    await advance(tb, 1999);
    assert.deepEqual(editorCalls(tb), [], "still waiting at 2999 ms");
    await advance(tb, 1);
    // Checked before awaiting the click, so a regression fails here instead of hanging.
    assert.deepEqual(editorCalls(tb), [["browserAction.openPopup", true]], "toolbar panel at 3000 ms, header panel not tried");
    await clicked;
    assert.deepEqual(displayedAnswers(tb), ["pending", "pending"], "getDisplayedMessage never answered");
    await flush();
    assert.equal(tb.popups.length, 1);
    assert.equal(tb.popups[0].url, BASE_URL + "note.html?id=1");
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    // The display finishing later opens nothing more.
    tb.finishMessageLoad();
    await advance(tb, 2000);
    assert.equal(tb.popups.length, 1);
    assertClean(tb);
  });

  it("a display that finishes within the second is used as usual (header panel)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id], { loaded: false });
    const clicked = tb.clickMenuItem("mail-note", [msgs[0].id]);
    await advance(tb, 300);
    tb.finishMessageLoad();
    await flush();
    assert.deepEqual(editorCalls(tb), [["messageDisplayAction.openPopup", true]]);
    await clicked;
    await advance(tb, 1000);
    await flush();
    assert.equal(tb.popups.length, 1, "the 1 s timer firing later changes nothing");
    assert.equal(popupText(tb.popups[0]).subject, "Invoice 42");
    assertClean(tb);
  });

  it("a header button click finds the selected message after 1 s when the display never finishes", async (t) => {
    // Until v0.4.2 this was the toolbar button; since v0.5.0 the header button
    // is the only button that opens note.html without an id.
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[1].id], { loaded: false });
    const popup = tb.clickActionButton("messageDisplayAction");
    assert.equal(popup.url, POPUP_URL);
    await flush();
    const text = () => popup.page.document.getElementById("text");
    assert.equal(text().disabled, true, "nothing to edit yet");
    await advance(tb, 999);
    assert.equal(popupText(popup).subject, "");
    await advance(tb, 1);
    assert.equal(popupText(popup).subject, "Quote for racks", "found through the list selection");
    assert.equal(text().disabled, false);
    assert.deepEqual(argsOf(tb, "mailTabs.getSelectedMessages"), [[tb.mailTab.id]]);
    assertClean(tb);
  });
});

describe("\"load\" request (editor asks for its message)", { skip }, () => {
  it("with an id returns that message and its note", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, storage: { "note:msg2@example.com": "Chase Bob" } });
    assert.deepEqual(await send(tb, { type: "load", id: msgs[1].id }), { id: 2, subject: "Quote for racks", text: "Chase Bob" });
    assertClean(tb);
  });

  it("without an id uses the displayed message, even straight after a right-click on another one", async (t) => {
    // v0.4.0 gave an id-less load the right-clicked message for 5 s. In v0.4.1
    // the right-click's id travels only in its panel's URL. v0.6.0 selects the
    // right-clicked message, so it is the displayed one until the user clicks
    // another.
    const { tb, msgs } = await boot(t, { messages: THREE, config: { popupLoads: false } });
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[1].id]);
    assert.equal((await send(tb, { type: "load", id: null })).id, msgs[1].id, "the right-clicked message is now displayed");
    tb.selectMessages([msgs[0].id]); // the user clicks Invoice 42 again
    assert.equal((await send(tb, { type: "load", id: null })).id, msgs[0].id);
    assert.equal((await send(tb, { type: "load" })).id, msgs[0].id);
    await advance(tb, 4999);
    assert.equal((await send(tb, { type: "load", id: null })).id, msgs[0].id, "at any time");
    assertClean(tb);
  });

  it("an explicit id is used as given, whatever is displayed or was right-clicked", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, config: { popupLoads: false } });
    tb.selectMessages([msgs[0].id]);
    await tb.clickMenuItem("mail-note", [msgs[1].id]);
    assert.equal((await send(tb, { type: "load", id: msgs[2].id })).id, msgs[2].id);
    assert.equal(tb.apiCalls("tabs.query").length, 0, "no need to look at the window");
    assertClean(tb);
  });

  it("with the id of a message that no longer exists, rejects with Thunderbird's error", async (t) => {
    // e.g. the message was deleted or moved between the right-click and the
    // panel loading; messages.get rejects (ext-messages.js:1232-1236).
    const { tb } = await boot(t, { messages: THREE });
    await assert.rejects(send(tb, { type: "load", id: 99 }), { message: "Message not found: 99." });
    assertClean(tb);
  });

  it("without an id uses the message shown in the current window", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[1].id]);
    assert.deepEqual(await send(tb, { type: "load" }), { id: 2, subject: "Quote for racks", text: "" });
    assert.deepEqual(argsOf(tb, "tabs.query"), [[{ active: true, currentWindow: true }]]);
    assert.deepEqual(argsOf(tb, "mailTabs.getSelectedMessages"), [], "the list is only asked when nothing is displayed");
    assertClean(tb);
  });

  it("uses a separate message window's message when that window is current", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    tb.openMessageWindow(msgs[2].id);
    assert.equal((await send(tb, { type: "load" })).id, msgs[2].id);
    assertClean(tb);
  });

  it("returns null when nothing (or several messages) is displayed", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    assert.equal(await send(tb, { type: "load" }), null);
    tb.selectMessages([msgs[0].id, msgs[1].id]);
    assert.equal(await send(tb, { type: "load" }), null);
    assertClean(tb);
  });

  it("with the reading pane hidden uses the one message selected in the list", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, storage: { "note:msg2@example.com": "Chase Bob" } });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[1].id]);
    assert.deepEqual(await send(tb, { type: "load" }), { id: 2, subject: "Quote for racks", text: "Chase Bob" });
    assert.equal(tb.apiCalls("messageDisplay.getDisplayedMessage")[0].result, null, "nothing is displayed");
    assert.deepEqual(argsOf(tb, "mailTabs.getSelectedMessages"), [[tb.mailTab.id]]);
    assertClean(tb);
  });

  it("with the reading pane hidden returns null for several selected messages or a collapsed thread", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.setMessagePaneVisible(false);
    tb.selectMessages(msgs.map((m) => m.id)); // a collapsed thread is selected as all its messages
    assert.equal(await send(tb, { type: "load" }), null);
    tb.selectMessages([]);
    assert.equal(await send(tb, { type: "load" }), null);
    assertClean(tb);
  });

  it("returns null without errors when the current tab is not a mail tab", async (t) => {
    // e.g. the editor's own tab: getDisplayedMessage gives null and
    // mailTabs.getSelectedMessages rejects ("Invalid mail tab ID").
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    tb.addTab(tb.mainWindow.id, "content", { url: "https://example.com/" });
    assert.equal(await send(tb, { type: "load" }), null);
    assert.match(tb.apiCalls("mailTabs.getSelectedMessages")[0].rejected, /Invalid mail tab ID/);
    assertClean(tb);
  });
});

describe("\"save\" request", { skip }, () => {
  it("stores trimmed text under note:<Message-ID> and adds the tag, keeping other tags", async (t) => {
    const { tb, msgs } = await boot(t, { messages: [{ subject: "Invoice 42", tags: ["$label1"] }] });
    assert.equal(await send(tb, { type: "save", id: msgs[0].id, text: "  Waiting for PO 7781 \n" }), true);
    assert.deepEqual([...tb.storage], [
      ["note:msg1@example.com", "Waiting for PO 7781"],
      ["info:msg1@example.com", infoFor(1)],
    ]);
    assert.deepEqual(argsOf(tb, "storage.local.set"), [[{ "note:msg1@example.com": "Waiting for PO 7781", "info:msg1@example.com": infoFor(1) }]], "note and info in one write");
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["$label1", "mailnote"]);
    assertClean(tb);
  });

  it("writes the note before doing any tag work", async (t) => {
    const { tb, msgs } = await boot(t);
    const from = tb.calls.length;
    await send(tb, { type: "save", id: msgs[0].id, text: "x" });
    const order = tb.calls.slice(from).map((c) => c.api).filter((a) => /^(storage\.local\.set|messages\.(tags\.|update))/.test(a));
    assert.equal(order[0], "storage.local.set");
    assert.ok(order.includes("messages.update"));
    assertClean(tb);
  });

  it("editing replaces the text and keeps a single tag", async (t) => {
    const { tb, msgs } = await boot(t);
    await send(tb, { type: "save", id: 1, text: "first" });
    await send(tb, { type: "save", id: 1, text: "second" });
    assert.equal(tb.storage.get("note:msg1@example.com"), "second");
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["mailnote"]);
    assertClean(tb);
  });

  it("whitespace-only text deletes the note and removes only the Note tag", async (t) => {
    const { tb, msgs } = await boot(t, {
      messages: [{ subject: "Invoice 42", tags: ["$label1", "mailnote"] }],
      storage: { "note:msg1@example.com": "old" },
    });
    assert.equal(await send(tb, { type: "save", id: msgs[0].id, text: " \n\t " }), true);
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["$label1"]);
    assertClean(tb);
  });

  it("an empty save on a message without a note changes nothing", async (t) => {
    const { tb, msgs } = await boot(t, { messages: [{ subject: "x", tags: ["$label2"] }] });
    assert.equal(await send(tb, { type: "save", id: msgs[0].id, text: "" }), true);
    assert.equal(tb.storage.size, 0);
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["$label2"]);
    assertClean(tb);
  });

  it("keys a message without Message-ID by its id (which is per session)", async (t) => {
    // The fallback key uses MessageHeader.id, a per-session counter
    // (ExtensionMessages.sys.mjs:1102, :1316), so such a note can attach to a
    // different message after a restart.
    const { tb, msgs } = await boot(t, { messages: [{ subject: "No id", headerMessageId: "" }] });
    await send(tb, { type: "save", id: msgs[0].id, text: "x" });
    assert.deepEqual(Object.fromEntries(tb.storage), { "note:id:1": "x", "info:id:1": infoFor(1, { subject: "No id", mid: "" }) });
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["mailnote"]);
    assertClean(tb);
  });

  it("re-creates the tag on save if the user deleted it", async (t) => {
    const { tb, msgs } = await boot(t);
    tb.tags = tb.tags.filter((x) => x.key !== "mailnote");
    await send(tb, { type: "save", id: msgs[0].id, text: "x" });
    assert.ok(tb.tags.some((x) => x.key === "mailnote" && x.color === GREEN));
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["mailnote"]);
    assertClean(tb);
  });

  it("saving works when the user already has a tag named \"Note\" under another key", async (t) => {
    // The save path re-creates a missing tag; tags.create("mailnote", "Note", ...)
    // would reject with "Specified tag already exists: Note"
    // (ext-messages.js:2100-2101). Remove ours after startup so that save has to
    // create it next to the user's "Note".
    const { tb, msgs } = await boot(t, { tags: [...DEFAULT_TAGS, USER_NOTE_TAG] });
    tb.tags = tb.tags.filter((x) => x.key !== "mailnote");
    const from = tb.calls.length;
    assert.equal(await send(tb, { type: "save", id: msgs[0].id, text: "Waiting for PO" }), true);
    const created = tb.calls.slice(from).filter((c) => c.api === "messages.tags.create");
    assert.deepEqual(created.map((c) => [c.args, c.rejected]), [[["mailnote", "tNOTE", GREEN], undefined]]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Waiting for PO");
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["mailnote"], "the message is tagged");
    assert.deepEqual(tb.tags.find((x) => x.key === "note"), USER_NOTE_TAG);
    assert.deepEqual(warnings(tb), []);
    assertClean(tb);
  });

  it("saving a note on an opened .eml file (external message) completes", async (t) => {
    // messages.update throws "Operation not permitted for external messages"
    // (ext-messages.js:1642-1646); v0.4.0 does not try to tag such a message.
    const { tb, msgs } = await boot(t, { messages: [{ subject: "Opened from file", external: true }] });
    tb.openMessageWindow(msgs[0].id);
    const loaded = await send(tb, { type: "load" });
    assert.equal(loaded.id, msgs[0].id);
    assert.equal(await send(tb, { type: "save", id: loaded.id, text: "From the auditor" }), true);
    assert.equal(tb.storage.get("note:msg1@example.com"), "From the auditor");
    assert.deepEqual(argsOf(tb, "messages.update"), [], "no tagging attempted");
    assert.deepEqual(warnings(tb), []);
    // Deleting works the same way.
    assert.equal(await send(tb, { type: "save", id: loaded.id, text: "" }), true);
    assert.equal(tb.storage.size, 0);
    assert.deepEqual(argsOf(tb, "messages.update"), []);
    assertClean(tb);
  });

  it("keeps the note and reports success when tagging fails", async (t) => {
    const { tb, msgs } = await boot(t);
    tb.faults["messages.update"] = new Error("folder is read-only");
    assert.equal(await send(tb, { type: "save", id: msgs[0].id, text: "Still here" }), true);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Still here");
    assert.equal(warnings(tb).length, 1);
    assert.match(warnings(tb)[0], /note saved but the message could not be tagged.*folder is read-only/);
    assertClean(tb);
  });

  it("keeps the note when both \"Note\" and \"tNOTE\" are taken by the user's own tags", async (t) => {
    const theirs = [USER_NOTE_TAG, { key: "tnote", tag: "tNOTE", color: "#123456", ordinal: "" }];
    const { tb, msgs } = await boot(t, { tags: [...DEFAULT_TAGS, ...theirs] });
    assert.equal(warnings(tb).length, 1, "startup logged the failed tag set-up");
    assert.equal(await send(tb, { type: "save", id: msgs[0].id, text: "x" }), true);
    assert.equal(tb.storage.get("note:msg1@example.com"), "x");
    assert.deepEqual(tagsOf(tb, msgs[0].id), [], "untagged, but saved");
    assert.equal(warnings(tb).length, 2);
    assertClean(tb);
  });

  it("rejects when the note itself cannot be stored, without touching tags", async (t) => {
    const { tb, msgs } = await boot(t);
    tb.faults["storage.local.set"] = new Error("disk full");
    await assert.rejects(send(tb, { type: "save", id: msgs[0].id, text: "x" }), /disk full/);
    assert.deepEqual(argsOf(tb, "messages.update"), []);
    assertClean(tb);
  });
});

describe("\"info:\" kept next to each note for the All notes list (v0.5.0)", { skip }, () => {
  it("adding a note writes info:<Message-ID> with subject, author, date (ms) and Message-ID, in the same write", async (t) => {
    const { tb, msgs } = await boot(t, { messages: [{ subject: "Quote for racks", author: "Bob <bob@racks.example>" }] });
    await send(tb, { type: "save", id: msgs[0].id, text: "Chase Bob" });
    assert.deepEqual(argsOf(tb, "storage.local.set"), [
      [{ "note:msg1@example.com": "Chase Bob", "info:msg1@example.com": infoFor(1, { subject: "Quote for racks", author: "Bob <bob@racks.example>" }) }],
    ]);
    assert.equal(typeof tb.storage.get("info:msg1@example.com").date, "number", "the date is stored as a number, not a Date");
    assertClean(tb);
  });

  it("editing rewrites the info from the message as it is now", async (t) => {
    const { tb, msgs } = await boot(t, {
      storage: { "note:msg1@example.com": "old", "info:msg1@example.com": { subject: "stale", author: "", date: 0, mid: "msg1@example.com" } },
    });
    await send(tb, { type: "save", id: msgs[0].id, text: "new" });
    assert.deepEqual(Object.fromEntries(tb.storage), { "note:msg1@example.com": "new", "info:msg1@example.com": infoFor(1) });
    assertClean(tb);
  });

  it("deleting a note removes the note and its info in one call, and leaves other notes alone", async (t) => {
    const { tb, msgs } = await boot(t, {
      messages: THREE,
      storage: {
        "note:msg1@example.com": "old",
        "info:msg1@example.com": infoFor(1),
        "note:msg2@example.com": "keep",
        "info:msg2@example.com": infoFor(2, { subject: "Quote for racks" }),
      },
    });
    await send(tb, { type: "save", id: msgs[0].id, text: "  " });
    assert.deepEqual(argsOf(tb, "storage.local.remove"), [[["note:msg1@example.com", "info:msg1@example.com"]]]);
    assert.deepEqual(Object.fromEntries(tb.storage), { "note:msg2@example.com": "keep", "info:msg2@example.com": infoFor(2, { subject: "Quote for racks" }) });
    assertClean(tb);
  });

  it("deleting a note saved before v0.5.0 (no info) works", async (t) => {
    const { tb, msgs } = await boot(t, { storage: { "note:msg1@example.com": "old" } });
    assert.equal(await send(tb, { type: "save", id: msgs[0].id, text: "" }), true);
    assert.equal(tb.storage.size, 0);
    assertClean(tb);
  });

  it("a note that cannot be stored leaves no info behind either", async (t) => {
    const { tb, msgs } = await boot(t);
    tb.faults["storage.local.set"] = new Error("disk full");
    await assert.rejects(send(tb, { type: "save", id: msgs[0].id, text: "x" }), /disk full/);
    assert.equal(tb.storage.size, 0);
    assertClean(tb);
  });
});

describe("saves run one at a time (v0.4.1)", { skip }, () => {
  /** The background's storage and tag writes, in the order Thunderbird got them. */
  const writes = (tb) =>
    tb.calls
      .filter((c) => c.context === "background" && /^(messages\.get|storage\.local\.(set|remove)|messages\.update)$/.test(c.api))
      .map((c) => (c.api === "messages.update" ? [c.api, c.args[1].tags] : c.api === "messages.get" ? [c.api] : [c.api, c.args[0]]));

  it("an add and a clear sent together for one message end with no note and no tag, in the order sent", async (t) => {
    const { tb, msgs } = await boot(t, { messages: [{ subject: "Invoice 42", tags: ["$label2"] }] });
    const from = tb.calls.length;
    const add = send(tb, { type: "save", id: msgs[0].id, text: "Call Bob" });
    const clear = send(tb, { type: "save", id: msgs[0].id, text: "" });
    assert.deepEqual(await Promise.all([add, clear]), [true, true]);
    await flush();
    assert.equal(tb.storage.has("note:msg1@example.com"), false, "no note");
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["$label2"], "no Note tag, other tags kept");
    assert.deepEqual(
      writes({ calls: tb.calls.slice(from) }),
      [
        ["messages.get"],
        ["storage.local.set", { "note:msg1@example.com": "Call Bob", "info:msg1@example.com": infoFor(1) }],
        ["messages.update", ["$label2", "mailnote"]],
        ["messages.get"],
        ["storage.local.remove", ["note:msg1@example.com", "info:msg1@example.com"]],
        ["messages.update", ["$label2"]],
      ],
      "the clear starts only after the add has finished"
    );
    assertClean(tb);
  });

  it("a clear that arrives while the add is still setting up the tag waits for it, so the tag cannot outlive the note", async (t) => {
    // The add path does more work after storing the note (ensureTag ->
    // tags.list) than the clear path, so without the queue the clear's tag
    // write would land first and the add's would put the tag back.
    const { tb, msgs } = await boot(t);
    const from = tb.calls.length;
    const slow = tb.hold("messages.tags.list");
    const add = send(tb, { type: "save", id: msgs[0].id, text: "Call Bob" });
    await flush();
    const clear = send(tb, { type: "save", id: msgs[0].id, text: "" });
    await flush();
    assert.deepEqual(
      writes({ calls: tb.calls.slice(from) }),
      [["messages.get"], ["storage.local.set", { "note:msg1@example.com": "Call Bob", "info:msg1@example.com": infoFor(1) }]],
      "the clear has not started while the add is busy"
    );
    slow.release();
    assert.deepEqual(await Promise.all([add, clear]), [true, true]);
    await flush();
    assert.equal(tb.storage.size, 0);
    assert.deepEqual(tagsOf(tb, msgs[0].id), []);
    assertClean(tb);
  });

  it("a save that fails does not block the next one", async (t) => {
    const { tb, msgs } = await boot(t, { storage: { "note:msg1@example.com": "old" } });
    tb.faults["storage.local.set"] = new Error("disk full");
    const add = send(tb, { type: "save", id: msgs[0].id, text: "new" });
    const clear = send(tb, { type: "save", id: msgs[0].id, text: "" });
    await assert.rejects(add, /disk full/);
    assert.equal(await clear, true);
    assert.equal(tb.storage.size, 0, "the clear still ran");
    assertClean(tb);
  });

  it("saves for different messages are queued too, and each lands on its own message", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    const results = await Promise.all(msgs.map((m) => send(tb, { type: "save", id: m.id, text: `note ${m.id}` })));
    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(Object.fromEntries(tb.storage), {
      "note:msg1@example.com": "note 1",
      "info:msg1@example.com": infoFor(1, { subject: "Invoice 42" }),
      "note:msg2@example.com": "note 2",
      "info:msg2@example.com": infoFor(2, { subject: "Quote for racks" }),
      "note:msg3@example.com": "note 3",
      "info:msg3@example.com": infoFor(3, { subject: "Lunch?" }),
    });
    for (const m of msgs) assert.deepEqual(tagsOf(tb, m.id), ["mailnote"]);
    assertClean(tb);
  });
});

describe("\"forDisplay\" request (message display script)", { skip }, () => {
  it("returns the key and note of the message shown in the sender's tab", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE, storage: { "note:msg2@example.com": "Chase Bob" } });
    tb.mailTab.selected = [msgs[1].id];
    assert.deepEqual(await contentApi(tb, tb.mailTab).runtime.sendMessage({ type: "forDisplay" }), { key: "note:msg2@example.com", text: "Chase Bob" });
    assertClean(tb);
  });

  it("returns an empty text when the message has no note", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.mailTab.selected = [msgs[0].id];
    assert.deepEqual(await contentApi(tb, tb.mailTab).runtime.sendMessage({ type: "forDisplay" }), { key: "note:msg1@example.com", text: "" });
    assertClean(tb);
  });

  it("returns null when the sender's tab shows no single message", async (t) => {
    const { tb } = await boot(t, { messages: THREE });
    assert.equal(await contentApi(tb, tb.mailTab).runtime.sendMessage({ type: "forDisplay" }), null);
    assertClean(tb);
  });

  it("returns null (not an error) to a sender without a tab, such as an extension panel", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.mailTab.selected = [msgs[0].id]; // a message is on display, but not to this sender
    assert.equal(await send(tb, { type: "forDisplay" }), null);
    assert.equal(tb.apiCalls("messageDisplay.getDisplayedMessage").length, 0);
    assertClean(tb);
  });
});

describe("\"forDisplay\" keeps a noted message's folder on record (v0.6.0)", { skip }, () => {
  const MESSAGES = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }, { subject: "Lunch?", folder: "Archives" }];
  /** display.js's request from the message shown in `tab`, then whatever background.js did after answering. */
  async function forDisplay(tb, tab = tb.mailTab) {
    const answer = await contentApi(tb, tab).runtime.sendMessage({ type: "forDisplay" });
    await flush();
    return answer;
  }
  const writes = (tb, from = 0) => tb.calls.slice(from).filter((c) => c.api === "storage.local.set").map((c) => c.args[0]);

  it("adds the folder to the record of a note saved by v0.5.0", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg2@example.com": "Chase Bob", "info:msg2@example.com": infoV050(2, { subject: "Quote for racks" }) },
    });
    tb.mailTab.selected = [2];
    assert.deepEqual(await forDisplay(tb), { key: "note:msg2@example.com", text: "Chase Bob" });
    assert.deepEqual(writes(tb), [{ "info:msg2@example.com": infoFor(2, { subject: "Quote for racks" }) }]);
    assertClean(tb);
  });

  it("writes the whole record of a note saved before v0.5.0 (no info at all)", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg3@example.com": "Book a table" } });
    tb.mailTab.folder = tb.folder("Archives");
    tb.mailTab.selected = [3];
    assert.deepEqual(await forDisplay(tb), { key: "note:msg3@example.com", text: "Book a table" });
    assert.deepEqual(tb.storage.get("info:msg3@example.com"), infoFor(3, { subject: "Lunch?", folderId: ARCHIVES }));
    assertClean(tb);
  });

  it("records the new folder of a message that was moved", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1) },
    });
    const moved = tb.moveMessage(1, "Archives");
    tb.mailTab.folder = tb.folder("Archives");
    tb.mailTab.selected = [moved.id];
    assert.deepEqual(await forDisplay(tb), { key: "note:msg1@example.com", text: "PO" });
    assert.deepEqual(writes(tb), [{ "info:msg1@example.com": infoFor(1, { folderId: ARCHIVES }) }]);
    assertClean(tb);
  });

  it("writes nothing when the record already names the message's folder", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1) } });
    tb.mailTab.selected = [1];
    assert.deepEqual(await forDisplay(tb), { key: "note:msg1@example.com", text: "PO" });
    assert.deepEqual(writes(tb), []);
    assertClean(tb);
  });

  it("writes nothing for a message without a note", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    tb.mailTab.selected = [1];
    assert.deepEqual(await forDisplay(tb), { key: "note:msg1@example.com", text: "" });
    assert.deepEqual(writes(tb), []);
    assert.equal(tb.storage.size, 0);
    assertClean(tb);
  });

  it("writes nothing for a noted message opened from a file, or one without a Message-ID", async (t) => {
    const { tb, msgs } = await boot(t, {
      messages: [{ subject: "Opened from file", external: true }, { subject: "No id", headerMessageId: "" }],
      storage: { "note:msg1@example.com": "From the auditor", "note:id:2": "x" },
    });
    const { tab } = tb.openMessageWindow(msgs[0].id);
    assert.deepEqual(await forDisplay(tb, tab), { key: "note:msg1@example.com", text: "From the auditor" });
    tb.mailTab.selected = [msgs[1].id];
    assert.deepEqual(await forDisplay(tb), { key: "note:id:2", text: "x" });
    assert.deepEqual(writes(tb).filter((w) => Object.keys(w).some((k) => k.startsWith("info:"))), []);
    assert.deepEqual([...tb.storage.keys()].sort(), ["note:id:2", "note:msg1@example.com"]);
    assertClean(tb);
  });

  it("an opened .eml copy of a noted message leaves the stored message's record alone", async (t) => {
    // The note is keyed by Message-ID, so the copy shows it; but the copy is
    // in no folder, and must not overwrite where the stored message is.
    const { tb } = await boot(t, {
      messages: [...MESSAGES, { subject: "Invoice 42", headerMessageId: "msg1@example.com", external: true }],
      storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1) },
    });
    const { tab } = tb.openMessageWindow(4);
    assert.deepEqual(await forDisplay(tb, tab), { key: "note:msg1@example.com", text: "PO" });
    assert.deepEqual(writes(tb), []);
    assert.deepEqual(tb.storage.get("info:msg1@example.com"), infoFor(1));
    assertClean(tb);
  });

  it("a record that cannot be written is logged, and the bar still gets its note", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg1@example.com": "PO" } });
    tb.faults["storage.local.set"] = new Error("disk full");
    tb.mailTab.selected = [1];
    assert.deepEqual(await forDisplay(tb), { key: "note:msg1@example.com", text: "PO" });
    assert.deepEqual(warnings(tb), ["tNOTE: Error: disk full"]);
    assertClean(tb);
  });
});

describe("finding a noted message: its folder on record first, all folders only if needed (v0.6.0)", { skip }, () => {
  // A search without a folder checks every message header of every folder of
  // every account (ExtensionMessages.sys.mjs:2366-2372, :2637-2696), which took
  // far too long on the owner's mailbox; a folderId search checks that folder
  // only (:2312-2317, :2351-2365). tb.searches records what each one walked.
  const MESSAGES = [
    { subject: "Invoice 42" },
    { subject: "Quote for racks", author: "Bob Smith <bob@racks.example>" },
    { subject: "Lunch?", author: "Cat <cat@example.com>", folder: "Archives" },
  ];
  const queries = (tb) => argsOf(tb, "messages.query");

  it("describe: a note without details is looked up in all folders once, and its folder recorded", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg3@example.com": "Book a table" } });
    const lunch = infoFor(3, { subject: "Lunch?", author: "Cat <cat@example.com>", folderId: ARCHIVES });
    assert.deepEqual(await send(tb, { type: "describe", mid: "msg3@example.com" }), lunch);
    assert.deepEqual(queries(tb), [everywhere("msg3@example.com")]);
    assert.deepEqual(tb.searches, [{ folderIds: [INBOX, ARCHIVES], checked: 3 }]);
    assert.deepEqual(tb.storage.get("info:msg3@example.com"), lunch);
    // Next time only its folder is searched, and nothing is rewritten.
    const from = tb.calls.length;
    assert.deepEqual(await send(tb, { type: "describe", mid: "msg3@example.com" }), lunch);
    assert.deepEqual(queries(tb).slice(1), [inFolder(ARCHIVES, "msg3@example.com")]);
    assert.deepEqual(tb.searches[1], { folderIds: [ARCHIVES], checked: 1 });
    assert.deepEqual(tb.calls.slice(from).filter((c) => c.api === "storage.local.set"), [], "nothing rewritten");
    assertClean(tb);
  });

  it("the folder on record is searched alone when the message is there, and nothing is written", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg2@example.com": "Chase Bob", "info:msg2@example.com": infoFor(2, { subject: "Quote for racks", author: "Bob Smith <bob@racks.example>" }) },
    });
    assert.deepEqual(await send(tb, { type: "reveal", mid: "msg2@example.com", windowId: tb.mainWindow.id }), { id: 2 });
    assert.deepEqual(queries(tb), [inFolder(INBOX, "msg2@example.com")]);
    assert.deepEqual(tb.searches, [{ folderIds: [INBOX], checked: 2 }], "the Archives folder is never walked");
    assert.deepEqual(argsOf(tb, "storage.local.set"), []);
    assertClean(tb);
  });

  it("a message moved since is found by the all-folders search, and its new folder is recorded", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1) } });
    const moved = tb.moveMessage(1, "Archives");
    assert.deepEqual(await send(tb, { type: "reveal", mid: "msg1@example.com", windowId: tb.mainWindow.id }), { id: moved.id });
    assert.deepEqual(queries(tb), [inFolder(INBOX, "msg1@example.com"), everywhere("msg1@example.com")]);
    assert.deepEqual(tb.storage.get("info:msg1@example.com"), infoFor(1, { folderId: ARCHIVES }));
    assert.deepEqual([tb.mailTab.folder.name, tb.mailTab.selected], ["Archives", [moved.id]]);
    // The next search goes straight to Archives.
    assert.deepEqual(await send(tb, { type: "reveal", mid: "msg1@example.com", windowId: tb.mainWindow.id }), { id: moved.id });
    assert.deepEqual(queries(tb).slice(2), [inFolder(ARCHIVES, "msg1@example.com")]);
    assertClean(tb);
  });

  it("a recorded folder that no longer exists falls back to all folders, and the record is corrected", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1, { folderId: "account1://Old" }) },
    });
    assert.deepEqual(await send(tb, { type: "describe", mid: "msg1@example.com" }), infoFor(1));
    assert.equal(tb.apiCalls("messages.query")[0].rejected, "Folder not found: account1://Old");
    assert.deepEqual(queries(tb), [inFolder("account1://Old", "msg1@example.com"), everywhere("msg1@example.com")]);
    assert.deepEqual(tb.storage.get("info:msg1@example.com"), infoFor(1));
    assertClean(tb);
  });

  it("a record from v0.5.0 (no folder) searches all folders once and gains the folder", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg3@example.com": "Book a table", "info:msg3@example.com": infoV050(3, { subject: "Lunch?", author: "Cat <cat@example.com>" }) },
    });
    assert.deepEqual(await send(tb, { type: "reveal", mid: "msg3@example.com", windowId: tb.mainWindow.id }), { id: 3 });
    assert.deepEqual(queries(tb), [everywhere("msg3@example.com")]);
    assert.deepEqual(tb.storage.get("info:msg3@example.com"), infoFor(3, { subject: "Lunch?", author: "Cat <cat@example.com>", folderId: ARCHIVES }));
    assertClean(tb);
  });

  it("a message that is gone: each reveal searches its folder, then all folders, answers null and leaves the record alone", async (t) => {
    // (describe of a message that is gone records it as missing since v0.6.1:
    // see the next group.)
    const record = infoFor(2, { subject: "Quote for racks" });
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg2@example.com": "Chase Bob", "info:msg2@example.com": record } });
    tb.deleteMessage(2);
    assert.equal(await send(tb, { type: "reveal", mid: "msg2@example.com", windowId: tb.mainWindow.id }), null);
    assert.equal(await send(tb, { type: "reveal", mid: "msg2@example.com", windowId: tb.mainWindow.id }), null);
    assert.deepEqual(queries(tb), [
      inFolder(INBOX, "msg2@example.com"),
      everywhere("msg2@example.com"),
      inFolder(INBOX, "msg2@example.com"),
      everywhere("msg2@example.com"),
    ]);
    assert.deepEqual(argsOf(tb, "storage.local.set"), []);
    assert.deepEqual(tb.storage.get("info:msg2@example.com"), record);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    assertClean(tb);
  });

  it("failing searches count as not found", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1), "note:msg2@example.com": "Chase Bob" },
    });
    tb.faults["messages.query"] = new Error("search failed");
    assert.equal(await send(tb, { type: "reveal", mid: "msg1@example.com", windowId: tb.mainWindow.id }), null);
    assert.equal(tb.apiCalls("messages.query").length, 2, "the folder search, then the all-folders one");
    assert.deepEqual(tb.storage.get("info:msg1@example.com"), infoFor(1), "a record is not touched");
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    // v0.6.1: a note without details is then recorded as missing, as for a message that is gone.
    assert.deepEqual(await send(tb, { type: "describe", mid: "msg2@example.com" }), { mid: "msg2@example.com", missing: true });
    assert.deepEqual(argsOf(tb, "messages.query").slice(2), [everywhere("msg2@example.com")]);
    assert.deepEqual(tb.apiCalls("messages.query").map((c) => c.rejected), ["search failed", "search failed", "search failed"]);
    assert.deepEqual(tb.storage.get("info:msg2@example.com"), { mid: "msg2@example.com", missing: true });
    assertClean(tb);
  });

  it("a request without a Message-ID finds nothing, searches nothing and writes nothing", async (t) => {
    // The list never asks this (list.js only describes rows with a Message-ID),
    // but background.js guards it. v0.6.1's describe records a missing message
    // without checking for a Message-ID first, so there it answers
    // { mid: null, missing: true } and writes an "info:null" record.
    const { tb } = await boot(t, { messages: [{ subject: "No id", headerMessageId: "" }], storage: { "note:id:1": "x" } });
    assert.equal(await send(tb, { type: "reveal", mid: null, windowId: tb.mainWindow.id }), null);
    assert.equal(await send(tb, { type: "describe", mid: null }), null);
    assert.deepEqual(queries(tb), []);
    assert.deepEqual(argsOf(tb, "storage.local.set"), []);
    assert.deepEqual([...tb.storage.keys()], ["note:id:1"]);
    assertClean(tb);
  });
});

describe("a message that cannot be found is recorded as missing, once (v0.6.1)", { skip }, () => {
  // v0.6.0's describe answered null and recorded nothing, so the list searched
  // every folder for such a note each time it opened, and showed
  // "Finding message…" for it forever.
  const MESSAGES = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }, { subject: "Lunch?", folder: "Archives" }];
  const MISSING = (mid) => ({ mid, missing: true });
  const queries = (tb) => argsOf(tb, "messages.query");
  const writes = (tb, from = 0) => tb.calls.slice(from).filter((c) => c.api === "storage.local.set").map((c) => c.args[0]);
  /** A message that was not there (not indexed, not yet arrived) and now is: message 4, in `folder`. */
  const turnUp = (tb, folder = "Archives") => tb.addMessage({ subject: "Late reply", headerMessageId: "late@example.com", folder });
  const lateInfo = (folderId) => infoFor(4, { subject: "Late reply", mid: "late@example.com", folderId });

  it("describe of a note whose message is gone searches all folders once, records it as missing and answers that", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:gone@example.com": "Orphan" } });
    assert.deepEqual(await send(tb, { type: "describe", mid: "gone@example.com" }), MISSING("gone@example.com"));
    assert.deepEqual(queries(tb), [everywhere("gone@example.com")]);
    assert.deepEqual(tb.searches, [{ folderIds: [INBOX, ARCHIVES], checked: 3 }]);
    assert.deepEqual(writes(tb), [{ "info:gone@example.com": MISSING("gone@example.com") }]);
    assert.equal(tb.storage.get("note:gone@example.com"), "Orphan", "the note itself is untouched");
    assertClean(tb);
  });

  it("a missing record that cannot be written is not claimed: describe rejects with the storage error", async (t) => {
    // So the list keeps the row on "Finding message…" and asks again next time,
    // rather than showing "(message not found)" for a search it will repeat.
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:gone@example.com": "Orphan" } });
    tb.faults["storage.local.set"] = new Error("disk full");
    await assert.rejects(send(tb, { type: "describe", mid: "gone@example.com" }), { message: "disk full" });
    assert.deepEqual(argsOf(tb, "storage.local.set"), [[{ "info:gone@example.com": MISSING("gone@example.com") }]]);
    assert.equal(tb.storage.has("info:gone@example.com"), false);
    assertClean(tb);
  });

  it("reveal of a missing record searches all folders (no folder on record) and leaves the record while still not found", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:gone@example.com": "Orphan", "info:gone@example.com": MISSING("gone@example.com") } });
    assert.equal(await send(tb, { type: "reveal", mid: "gone@example.com", windowId: tb.mainWindow.id }), null);
    assert.deepEqual(queries(tb), [everywhere("gone@example.com")]);
    assert.deepEqual(writes(tb), []);
    assert.deepEqual(tb.storage.get("info:gone@example.com"), MISSING("gone@example.com"));
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    assertClean(tb);
  });

  it("a missing message that turns up is found by reveal, selected, and its record replaced by the full one", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:late@example.com": "Reply due", "info:late@example.com": MISSING("late@example.com") } });
    const late = turnUp(tb);
    assert.deepEqual(await send(tb, { type: "reveal", mid: "late@example.com", windowId: tb.mainWindow.id }), { id: late.id });
    assert.deepEqual(queries(tb), [everywhere("late@example.com")]);
    assert.deepEqual(writes(tb), [{ "info:late@example.com": lateInfo(ARCHIVES) }], "missing is cleared");
    assert.deepEqual([tb.mailTab.folder.name, tb.mailTab.selected], ["Archives", [late.id]]);
    // From now on its folder is searched alone, and nothing is rewritten.
    const from = tb.calls.length;
    assert.deepEqual(await send(tb, { type: "reveal", mid: "late@example.com", windowId: tb.mainWindow.id }), { id: late.id });
    assert.deepEqual(queries(tb).slice(1), [inFolder(ARCHIVES, "late@example.com")]);
    assert.deepEqual(writes(tb, from), []);
    assertClean(tb);
  });

  it("a missing message that turns up gets its full record when it is displayed (forDisplay)", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:late@example.com": "Reply due", "info:late@example.com": MISSING("late@example.com") } });
    const late = turnUp(tb, "Inbox");
    tb.mailTab.selected = [late.id];
    const answer = await contentApi(tb, tb.mailTab).runtime.sendMessage({ type: "forDisplay" });
    await flush();
    assert.deepEqual(answer, { key: "note:late@example.com", text: "Reply due" });
    assert.deepEqual(writes(tb), [{ "info:late@example.com": lateInfo(INBOX) }], "missing is cleared");
    assert.deepEqual(queries(tb), [], "no search needed");
    assertClean(tb);
  });

  it("describe of a message with an empty subject records it once; asking again searches its folder only and writes nothing", async (t) => {
    // v0.6.0 took an empty subject for missing details: it rewrote the record on
    // every search, and the list described such a note on every opening.
    const { tb } = await boot(t, { messages: [{ subject: "" }], storage: { "note:msg1@example.com": "No subject line" } });
    const record = infoFor(1, { subject: "" });
    assert.deepEqual(await send(tb, { type: "describe", mid: "msg1@example.com" }), record);
    assert.deepEqual(writes(tb), [{ "info:msg1@example.com": record }]);
    const from = tb.calls.length;
    assert.deepEqual(await send(tb, { type: "describe", mid: "msg1@example.com" }), record);
    assert.deepEqual(queries(tb), [everywhere("msg1@example.com"), inFolder(INBOX, "msg1@example.com")]);
    assert.deepEqual(writes(tb, from), []);
    assertClean(tb);
  });

  it("a record with an empty subject is complete: reveal finds the message in its folder and rewrites nothing", async (t) => {
    const { tb } = await boot(t, { messages: [{ subject: "" }], storage: { "note:msg1@example.com": "No subject line", "info:msg1@example.com": infoFor(1, { subject: "" }) } });
    assert.deepEqual(await send(tb, { type: "reveal", mid: "msg1@example.com", windowId: tb.mainWindow.id }), { id: 1 });
    assert.deepEqual(queries(tb), [inFolder(INBOX, "msg1@example.com")]);
    assert.deepEqual(writes(tb), []);
    assertClean(tb);
  });
});

describe("\"reveal\" request: select the note's message in the list's window (v0.6.0)", { skip }, () => {
  const MESSAGES = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }, { subject: "Lunch?", folder: "Archives" }];
  const STORAGE = {
    "note:msg2@example.com": "Chase Bob",
    "info:msg2@example.com": infoFor(2, { subject: "Quote for racks" }),
    "note:msg3@example.com": "Book a table",
    "info:msg3@example.com": infoFor(3, { subject: "Lunch?", folderId: ARCHIVES }),
  };
  const reveal = (tb, mid, windowId) => send(tb, { type: "reveal", mid, windowId });

  it("selects in the active mail tab of the window it is given, whichever window has focus", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    const second = tb.openMainWindow(); // the second window has focus
    assert.deepEqual(await reveal(tb, "msg2@example.com", tb.mainWindow.id), { id: 2 });
    assert.deepEqual(argsOf(tb, "tabs.query"), [[{ active: true, windowId: tb.mainWindow.id, mailTab: true }]]);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [2]]]);
    assert.deepEqual(second.tab.selected, [], "the focused window is untouched");
    assert.deepEqual(await reveal(tb, "msg3@example.com", second.window.id), { id: 3 });
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages")[1], [second.tab.id, [3]]);
    assert.deepEqual([second.tab.folder.name, second.tab.selected], ["Archives", [3]], "switched to the message's folder");
    assert.deepEqual([tb.mailTab.folder.name, tb.mailTab.selected], ["Inbox", [2]]);
    assertClean(tb);
  });

  it("uses the selected mail tab, not another mail tab of the window", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    const front = tb.openMailTab(); // now the selected tab; tb.mailTab is in the background
    assert.deepEqual(await reveal(tb, "msg2@example.com", tb.mainWindow.id), { id: 2 });
    assert.deepEqual(front.selected, [2]);
    assert.deepEqual(tb.mailTab.selected, []);
    assertClean(tb);
  });

  it("with no mail tab in front, answers with the message without selecting anything", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    tb.addTab(tb.mainWindow.id, "messageDisplay", { selected: [1] });
    assert.deepEqual(await reveal(tb, "msg2@example.com", tb.mainWindow.id), { id: 2 });
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    assert.deepEqual(tb.mailTab.selected, []);
    assertClean(tb);
  });

  it("a selection that fails is logged, and the message is still answered", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    tb.unviewable.add(ARCHIVES);
    assert.deepEqual(await reveal(tb, "msg3@example.com", tb.mainWindow.id), { id: 3 });
    assert.deepEqual(warnings(tb), ["tNOTE: Error: Folder of the requested message(s) is not viewable in any of the enabled folder modes"]);
    assert.equal(tb.mailTab.folder.name, "Inbox");
    assertClean(tb);
  });
});

describe("\"remove\" request: delete a note from the list (v0.6.0)", { skip }, () => {
  const MESSAGES = [{ subject: "Invoice 42", tags: ["$label1", "mailnote"] }, { subject: "Quote for racks", tags: ["mailnote"] }];
  const STORAGE = {
    "note:msg1@example.com": "PO",
    "info:msg1@example.com": infoFor(1),
    "note:msg2@example.com": "Chase Bob",
    "info:msg2@example.com": infoFor(2, { subject: "Quote for racks" }),
  };
  // v0.6.1: the list names the note by its storage key suffix (a Message-ID,
  // or "id:N" for a message without one), not by Message-ID.
  const remove = (tb, key) => send(tb, { type: "remove", key });
  const order = (tb) => tb.calls.filter((c) => /^(storage\.local\.(remove|set)|messages\.(query|update))$/.test(c.api)).map((c) => c.api);

  it("removes the note and its record in one call, then untags the message found in the recorded folder", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    assert.equal(await remove(tb, "msg1@example.com"), true);
    assert.deepEqual(argsOf(tb, "storage.local.remove"), [[["note:msg1@example.com", "info:msg1@example.com"]]]);
    assert.deepEqual(argsOf(tb, "messages.query"), [inFolder(INBOX, "msg1@example.com")]);
    assert.deepEqual(argsOf(tb, "messages.update"), [[1, { tags: ["$label1"] }]]);
    assert.deepEqual(order(tb), ["storage.local.remove", "messages.query", "messages.update"], "the note goes first");
    assert.deepEqual(tagsOf(tb, 1), ["$label1"]);
    assert.deepEqual(Object.fromEntries(tb.storage), { "note:msg2@example.com": "Chase Bob", "info:msg2@example.com": infoFor(2, { subject: "Quote for racks" }) });
    assert.deepEqual(tagsOf(tb, 2), ["mailnote"], "the other note's message keeps its tag");
    assertClean(tb);
  });

  it("a message moved since is found through all folders and untagged, and no record is written back", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    const moved = tb.moveMessage(1, "Archives");
    assert.deepEqual(moved.tags, ["$label1", "mailnote"]);
    assert.equal(await remove(tb, "msg1@example.com"), true);
    assert.deepEqual(argsOf(tb, "messages.query"), [inFolder(INBOX, "msg1@example.com"), everywhere("msg1@example.com")]);
    assert.deepEqual(tagsOf(tb, moved.id), ["$label1"]);
    assert.deepEqual(argsOf(tb, "storage.local.set"), []);
    assert.equal(tb.storage.has("info:msg1@example.com"), false);
    assertClean(tb);
  });

  it("a note whose message is gone is still removed", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    tb.deleteMessage(1);
    assert.equal(await remove(tb, "msg1@example.com"), true);
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assert.equal(tb.storage.has("info:msg1@example.com"), false);
    assert.deepEqual(argsOf(tb, "messages.update"), []);
    assertClean(tb);
  });

  it("a note saved before v0.5.0 (no record) is removed and its message searched for everywhere", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg2@example.com": "Chase Bob" } });
    assert.equal(await remove(tb, "msg2@example.com"), true);
    assert.equal(tb.storage.size, 0);
    assert.deepEqual(argsOf(tb, "messages.query"), [everywhere("msg2@example.com")]);
    assert.deepEqual(tagsOf(tb, 2), []);
    assertClean(tb);
  });

  it("a message without the Note tag is left alone", async (t) => {
    const { tb } = await boot(t, { messages: [{ subject: "Invoice 42", tags: ["$label1"] }], storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1) } });
    assert.equal(await remove(tb, "msg1@example.com"), true);
    assert.deepEqual(argsOf(tb, "messages.update"), []);
    assertClean(tb);
  });

  it("an untagging failure is logged; the note stays removed", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    tb.faults["messages.update"] = new Error("folder is read-only");
    assert.equal(await remove(tb, "msg1@example.com"), true);
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assert.deepEqual(warnings(tb), ["tNOTE: Error: folder is read-only"]);
    assertClean(tb);
  });

  it("rejects when the note cannot be removed, before any search or tag change", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    tb.faults["storage.local.remove"] = new Error("disk full");
    await assert.rejects(remove(tb, "msg1@example.com"), { message: "disk full" });
    assert.deepEqual(argsOf(tb, "storage.local.remove"), [[["note:msg1@example.com", "info:msg1@example.com"]]], "the right note was asked for");
    assert.equal(tb.storage.get("note:msg1@example.com"), "PO");
    assert.deepEqual(argsOf(tb, "messages.query"), []);
    assert.deepEqual(tagsOf(tb, 1), ["$label1", "mailnote"]);
    assertClean(tb);
  });

  it("an \"id:\" key (a message without a Message-ID) removes note:id:N and info:id:N and searches nothing (v0.6.1)", async (t) => {
    // v0.6.0 sent the row's Message-ID, null here, and removed "note:null".
    // N is a per-session message id, so it is not trusted to name the message
    // after a restart: the message keeps its tag.
    const { tb } = await boot(t, {
      messages: [{ subject: "No id", headerMessageId: "", tags: ["mailnote"] }],
      storage: { "note:id:1": "Saved with v0.5.0", "info:id:1": infoFor(1, { subject: "No id", mid: "" }) },
    });
    assert.equal(await remove(tb, "id:1"), true);
    assert.deepEqual(argsOf(tb, "storage.local.remove"), [[["note:id:1", "info:id:1"]]]);
    assert.equal(tb.storage.size, 0);
    assert.deepEqual(argsOf(tb, "messages.query"), [], "no search: an all-folders search for \"id:1\" could never find it");
    assert.deepEqual(argsOf(tb, "messages.update"), []);
    assert.deepEqual(tagsOf(tb, 1), ["mailnote"]);
    assertClean(tb);
  });

  it("waits for a save still in flight, so that save cannot bring the note back (v0.6.1)", async (t) => {
    // The editor's last save (Done, ← All notes, closing) can still be running
    // when the note is deleted from the list.
    const { tb } = await boot(t, { messages: [{ subject: "Invoice 42" }], storage: { "note:msg1@example.com": "PO", "info:msg1@example.com": infoFor(1) } });
    const held = tb.hold("storage.local.set");
    const saving = send(tb, { type: "save", id: 1, text: "PO 7781" });
    await flush();
    const removing = remove(tb, "msg1@example.com");
    await flush();
    assert.deepEqual(argsOf(tb, "storage.local.remove"), [], "the remove waits for the save");
    assert.deepEqual(argsOf(tb, "messages.query"), []);
    held.release();
    assert.equal(await saving, true);
    assert.equal(await removing, true);
    await flush();
    assert.deepEqual(order(tb), ["storage.local.set", "messages.update", "storage.local.remove", "messages.query", "messages.update"]);
    assert.equal(tb.storage.has("note:msg1@example.com"), false, "the note stays deleted");
    assert.equal(tb.storage.has("info:msg1@example.com"), false);
    assert.deepEqual(tagsOf(tb, 1), [], "and its message untagged");
    assertClean(tb);
  });

  it("a save sent while a remove is still running waits for it: a note re-added at once keeps its text and tag (v0.6.1)", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    const held = tb.hold("messages.query"); // the remove's search for the message
    const removing = remove(tb, "msg1@example.com");
    await flush();
    assert.equal(tb.storage.has("note:msg1@example.com"), false, "the note is gone; the search for its message is held");
    const saving = send(tb, { type: "save", id: 1, text: "PO again" });
    await flush();
    assert.deepEqual(argsOf(tb, "messages.get"), [], "the save has not started");
    held.release();
    assert.equal(await removing, true);
    assert.equal(await saving, true);
    await flush();
    assert.deepEqual(argsOf(tb, "messages.update"), [[1, { tags: ["$label1"] }], [1, { tags: ["$label1", "mailnote"] }]], "untagged, then tagged again");
    assert.equal(tb.storage.get("note:msg1@example.com"), "PO again");
    assert.deepEqual(tb.storage.get("info:msg1@example.com"), infoFor(1));
    assert.deepEqual(tagsOf(tb, 1), ["$label1", "mailnote"]);
    assertClean(tb);
  });

  it("a remove that fails does not hold up later saves (v0.6.1)", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: STORAGE });
    tb.faults["storage.local.remove"] = new Error("disk full");
    await assert.rejects(remove(tb, "msg1@example.com"), { message: "disk full" });
    delete tb.faults["storage.local.remove"];
    assert.equal(await send(tb, { type: "save", id: 2, text: "Chase Bob on Friday" }), true);
    assert.equal(tb.storage.get("note:msg2@example.com"), "Chase Bob on Friday");
    assert.equal(await remove(tb, "msg2@example.com"), true, "nor later removes");
    assert.equal(tb.storage.has("note:msg2@example.com"), false);
    assertClean(tb);
  });
});

describe("other messages", { skip }, () => {
  it("an unknown request type gets an undefined response, not an error", async (t) => {
    const { tb } = await boot(t);
    assert.equal(await send(tb, { type: "bogus" }), undefined);
    assertClean(tb);
  });

  it("registers display.js as a message display script once", async (t) => {
    const { tb } = await boot(t);
    assert.deepEqual(argsOf(tb, "messageDisplayScripts.register"), [[{ js: [{ file: "display.js" }] }]]);
    assertClean(tb);
  });
});
