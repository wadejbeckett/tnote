"use strict";
// list.html + list.js (v0.5.0: the toolbar button's All notes panel), loaded
// unmodified into jsdom as the toolbar button's popup, against the real
// background.js and the schema-checked fake.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { boot, pageApi, assertClean, flush, skip, BASE_URL } = require("./harness/setup.js");

const LIST_URL = BASE_URL + "list.html";
const NO_NOTES = "No notes yet. Right-click a message and choose Add note…";
const NO_MATCH = "No notes match.";
const NOT_FOUND = "Couldn't find that message. It may have been deleted, or be in a folder Thunderbird hasn't opened lately; open that folder and try again.";
const NO_MID = "That message has no Message-ID, so it can't be found from here.";
// The fake dates message n 2026-10-01 09:0n UTC, so a higher id is newer.
const dateOf = (id) => new Date(Date.UTC(2026, 9, 1, 9, id)).toLocaleDateString();

const MESSAGES = [
  { subject: "Invoice 42", author: "Ann <ann@example.com>" },
  { subject: "Quote for racks", author: "Bob Smith <bob@racks.example>" },
  { subject: "Lunch?", author: "Cat <cat@example.com>", folder: "Archives" },
];

const save = (tb, id, text) => pageApi(tb).runtime.sendMessage({ type: "save", id, text });
const argsOf = (tb, api) => tb.apiCalls(api).map((c) => c.args);

/** Clicks the toolbar button and waits for the list to render. */
async function openList(tb, windowId) {
  const popup = tb.clickActionButton("browserAction", windowId);
  assert.equal(popup.url, LIST_URL, "the toolbar button opens the list");
  await flush();
  const doc = popup.page.document;
  const $ = (id) => doc.getElementById(id);
  const items = () => [...doc.querySelectorAll("#list li")];
  const rows = () =>
    items().map((li) => ({
      subject: li.querySelector(".subject").textContent,
      date: li.querySelector(".date").textContent,
      from: li.querySelector(".from").textContent,
      note: li.querySelector(".note").textContent,
    }));
  const search = (q) => {
    $("search").value = q;
    $("search").dispatchEvent(new popup.page.window.Event("input", { bubbles: true }));
  };
  const key = (el, k) => el.dispatchEvent(new popup.page.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { popup, doc, $, items, rows, search, key };
}

/** The note bar display.js put on a message display page, if any. */
const barText = (page) => page?.shadowRoots[0]?.root.querySelector("span").textContent;

describe("All notes list (list.html + list.js)", { skip }, () => {
  it("lists every note, newest message first, with subject, author, date and note text", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    // Saved out of date order on purpose.
    await save(tb, 2, "Chase Bob for the rack quote");
    await save(tb, 1, "Waiting for PO 7781");
    await save(tb, 3, "Book a table");
    const from = tb.calls.length;
    const { $, doc, items, rows } = await openList(tb);
    assert.deepEqual(rows(), [
      { subject: "Lunch?", date: dateOf(3), from: "Cat <cat@example.com>", note: "Book a table" },
      { subject: "Quote for racks", date: dateOf(2), from: "Bob Smith <bob@racks.example>", note: "Chase Bob for the rack quote" },
      { subject: "Invoice 42", date: dateOf(1), from: "Ann <ann@example.com>", note: "Waiting for PO 7781" },
    ]);
    assert.ok(dateOf(1), "a date is shown");
    assert.deepEqual(items().map((li) => li.tabIndex), [0, 0, 0], "each note can be reached with Tab");
    assert.equal($("status").textContent, "");
    assert.equal(doc.activeElement, $("search"), "the search box has the cursor");
    assert.deepEqual(argsOf(tb, "messages.query"), [], "saved notes carry their details: no message search");
    assert.deepEqual(tb.calls.slice(from).filter((c) => c.api.startsWith("storage.local.set")), [], "opening the list writes nothing");
    assertClean(tb);
  });

  it("search filters on note text, subject and author, ignoring case", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 1, "Waiting for PO 7781");
    await save(tb, 2, "Chase Bob for the rack quote");
    await save(tb, 3, "Book a table");
    const { $, rows, search } = await openList(tb);
    const subjects = () => rows().map((r) => r.subject);
    search("po 7781"); // note text
    assert.deepEqual(subjects(), ["Invoice 42"]);
    search("LUNCH"); // subject
    assert.deepEqual(subjects(), ["Lunch?"]);
    search("racks.example"); // author address
    assert.deepEqual(subjects(), ["Quote for racks"]);
    search("  ann  "); // author name, surrounding spaces ignored
    assert.deepEqual(subjects(), ["Invoice 42"]);
    search("b"); // matches several fields of several notes; order is kept
    assert.deepEqual(subjects(), ["Lunch?", "Quote for racks"]);
    assert.equal($("status").textContent, "");
    search("");
    assert.deepEqual(subjects(), ["Lunch?", "Quote for racks", "Invoice 42"]);
    assertClean(tb);
  });

  it("says there are no notes yet when there are none", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { unrelated: 1 } });
    const { $, rows, search } = await openList(tb);
    assert.deepEqual(rows(), []);
    assert.equal($("status").textContent, NO_NOTES);
    search("anything");
    assert.equal($("status").textContent, NO_NOTES, "still no notes, not \"no match\"");
    assertClean(tb);
  });

  it("says no notes match when the search finds none, and clears that when it does", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 1, "Waiting for PO 7781");
    const { $, rows, search } = await openList(tb);
    search("zebra");
    assert.deepEqual(rows(), []);
    assert.equal($("status").textContent, NO_MATCH);
    search("PO");
    assert.equal(rows().length, 1);
    assert.equal($("status").textContent, "");
    assertClean(tb);
  });

  it("shows subject, author and note as text, never as markup", async (t) => {
    const { tb } = await boot(t, { messages: [{ subject: "<b>Bold</b> offer", author: "<i>Eve</i> <eve@example.com>" }] });
    await save(tb, 1, '<img src="x" onerror="window.pwned = 1">');
    const { popup, doc, rows } = await openList(tb);
    assert.deepEqual(rows()[0], {
      subject: "<b>Bold</b> offer",
      date: dateOf(1),
      from: "<i>Eve</i> <eve@example.com>",
      note: '<img src="x" onerror="window.pwned = 1">',
    });
    assert.equal(doc.querySelectorAll("#list img, #list b, #list i").length, 0);
    assert.equal(popup.page.window.pwned, undefined);
    assertClean(tb);
  });

  it("clicking a note selects its message in the current mail tab and closes the list", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    await save(tb, 1, "PO");
    tb.selectMessages([1]);
    await flush();
    const { popup, items } = await openList(tb);
    items()[0].click(); // Quote for racks (newest)
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query"), [[{ headerMessageId: "msg2@example.com" }]]);
    assert.deepEqual(argsOf(tb, "tabs.query").at(-1), [{ active: true, currentWindow: true, mailTab: true }]);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [2]]]);
    assert.deepEqual(tb.mailTab.selected, [2]);
    assert.equal(tb.mailTab.folder.name, "Inbox");
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), [], "no extra tab");
    assert.equal(popup.page.closed, true, "the list closed itself");
    assert.equal(popup.destroyed, true, "the panel is gone");
    assert.equal(barText(tb.displayPages.at(-1)), "Chase Bob", "the message shows with its note bar");
    assertClean(tb);
  });

  it("a note on a message in another folder switches the mail tab to that folder", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 3, "Book a table");
    assert.equal(tb.mailTab.folder.name, "Inbox");
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [3]]]);
    assert.equal(tb.mailTab.folder.name, "Archives", "switched folder");
    assert.deepEqual(tb.mailTab.selected, [3]);
    assert.equal(popup.page.closed, true);
    assertClean(tb);
  });

  it("Enter on a focused note, or in the search box, opens the note (the first match)", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 1, "Waiting for PO");
    await save(tb, 2, "Chase Bob");
    let list = await openList(tb);
    list.key(list.items()[1], "Enter"); // Invoice 42
    await flush();
    assert.deepEqual(tb.mailTab.selected, [1]);
    assert.equal(list.popup.page.closed, true);

    list = await openList(tb);
    list.search("bob");
    list.key(list.$("search"), "Enter");
    await flush();
    assert.deepEqual(tb.mailTab.selected, [2]);
    assert.equal(list.popup.page.closed, true);

    list = await openList(tb);
    list.search("zebra");
    list.key(list.$("search"), "Enter"); // nothing to open
    list.key(list.$("search"), "a"); // other keys do nothing
    await flush();
    assert.equal(list.popup.page.closed, false);
    assert.equal(tb.apiCalls("mailTabs.setSelectedMessages").length, 2);
    assertClean(tb);
  });

  it("selects the message in the window the list was opened from", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    tb.selectMessages([1]);
    const second = tb.openMainWindow();
    const { popup, items } = await openList(tb, second.window.id);
    assert.equal(popup.windowId, second.window.id);
    items()[0].click();
    await flush();
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[second.tab.id, [2]]]);
    assert.deepEqual(second.tab.selected, [2]);
    assert.deepEqual(tb.mailTab.selected, [1], "the first window is untouched");
    assertClean(tb);
  });

  it("with no mail tab in front (a message tab is), opens the message in a new tab", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    const msgTab = tb.addTab(tb.mainWindow.id, "messageDisplay", { selected: [1] });
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [], "no mail tab to select in");
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), [[{ messageId: 2, location: "tab" }]]);
    const opened = tb.activeTab(tb.mainWindow.id);
    assert.notEqual(opened.id, msgTab.id);
    assert.equal(opened.type, "messageDisplay");
    assert.deepEqual(opened.selected, [2]);
    assert.deepEqual(tb.mailTab.selected, [], "the mail tab is untouched");
    assert.equal(popup.page.closed, true);
    assert.equal(barText(tb.displayPages.at(-1)), "Chase Bob");
    assertClean(tb);
  });

  it("when the mail tab cannot show the message's folder, opens the message in a new tab", async (t) => {
    // ext-mailTabs.js:722-727: no row for the folder in any enabled folder mode.
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 3, "Book a table");
    tb.unviewable.add(tb.folder("Archives").id);
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.match(tb.apiCalls("mailTabs.setSelectedMessages")[0].rejected, /not viewable in any of the enabled folder modes/);
    assert.equal(tb.mailTab.folder.name, "Inbox");
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), [[{ messageId: 3, location: "tab" }]]);
    assert.deepEqual(tb.activeTab(tb.mainWindow.id).selected, [3]);
    assert.equal(popup.page.closed, true);
    assertClean(tb);
  });

  it("when selecting fails for any other reason, opens the message in a new tab", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 1, "PO");
    tb.faults["mailTabs.setSelectedMessages"] = new Error("view not ready");
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), [[{ messageId: 1, location: "tab" }]]);
    assert.equal(popup.page.closed, true);
    assertClean(tb);
  });

  it("a note whose message was deleted is still listed; clicking it says so and keeps the list open", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    tb.deleteMessage(2);
    const { popup, $, items, rows } = await openList(tb);
    assert.deepEqual(rows(), [{ subject: "Quote for racks", date: dateOf(2), from: "Bob Smith <bob@racks.example>", note: "Chase Bob" }]);
    items()[0].click();
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query"), [[{ headerMessageId: "msg2@example.com" }]]);
    assert.equal(tb.apiCalls("messages.query")[0].result.messages.length, 0);
    assert.equal($("status").textContent, NOT_FOUND);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), []);
    assert.equal(popup.page.closed, false);
    assertClean(tb);
  });

  it("a failing message search counts as not found", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    tb.faults["messages.query"] = new Error("search failed");
    const { popup, $, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.equal($("status").textContent, NOT_FOUND);
    assert.equal(popup.page.closed, false);
    assertClean(tb);
  });

  it("fills in the details of notes saved before v0.5.0, once", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg2@example.com": "Chase Bob", "note:msg3@example.com": "Book a table" },
    });
    let list = await openList(tb);
    assert.deepEqual(list.rows(), [
      { subject: "Lunch?", date: dateOf(3), from: "Cat <cat@example.com>", note: "Book a table" },
      { subject: "Quote for racks", date: dateOf(2), from: "Bob Smith <bob@racks.example>", note: "Chase Bob" },
    ]);
    assert.deepEqual(argsOf(tb, "messages.query"), [[{ headerMessageId: "msg2@example.com" }], [{ headerMessageId: "msg3@example.com" }]]);
    assert.deepEqual(tb.storage.get("info:msg2@example.com"), {
      subject: "Quote for racks",
      author: "Bob Smith <bob@racks.example>",
      date: Date.UTC(2026, 9, 1, 9, 2),
      mid: "msg2@example.com",
    });
    assert.deepEqual(tb.storage.get("info:msg3@example.com"), {
      subject: "Lunch?",
      author: "Cat <cat@example.com>",
      date: Date.UTC(2026, 9, 1, 9, 3),
      mid: "msg3@example.com",
    });
    assert.equal(tb.storage.get("note:msg2@example.com"), "Chase Bob", "the note itself is untouched");
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    assert.equal(list.rows().length, 2);
    assert.equal(tb.apiCalls("messages.query").length, 2, "the second opening searches for nothing");
    // A click still finds the message through its Message-ID.
    list.items()[1].click();
    await flush();
    assert.deepEqual(tb.mailTab.selected, [2]);
    assertClean(tb);
  });

  it("an old note whose message is gone is listed last, without details, and not filled in", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:gone@example.com": "Orphan", "note:msg1@example.com": "PO", "info:msg1@example.com": { subject: "Invoice 42", author: "Ann <ann@example.com>", date: Date.UTC(2026, 9, 1, 9, 1), mid: "msg1@example.com" } },
    });
    const { $, rows, items } = await openList(tb);
    assert.deepEqual(rows(), [
      { subject: "Invoice 42", date: dateOf(1), from: "Ann <ann@example.com>", note: "PO" },
      { subject: "(no subject)", date: "", from: "", note: "Orphan" },
    ]);
    assert.deepEqual(argsOf(tb, "messages.query"), [[{ headerMessageId: "gone@example.com" }]]);
    assert.equal(tb.storage.has("info:gone@example.com"), false);
    items()[1].click();
    await flush();
    assert.equal($("status").textContent, NOT_FOUND);
    assertClean(tb);
  });

  it("notes on messages without a Message-ID (\"id:\" keys) are listed, but cannot be jumped to", async (t) => {
    // Their key is a per-session message id, so list.js does not look them up.
    const { tb } = await boot(t, { messages: [{ subject: "No id", headerMessageId: "" }, { subject: "Also no id", headerMessageId: "" }] });
    await save(tb, 1, "Saved with v0.5.0");
    tb.storage.set("note:id:2", "Saved before v0.5.0");
    tb.selectMessages([2]);
    await flush();
    const { popup, $, rows, items } = await openList(tb);
    assert.deepEqual(rows(), [
      { subject: "No id", date: dateOf(1), from: "Ann <ann@example.com>", note: "Saved with v0.5.0" },
      { subject: "(no subject)", date: "", from: "", note: "Saved before v0.5.0" },
    ]);
    assert.deepEqual(argsOf(tb, "messages.query"), [], "no backfill search for an id: key");
    for (const li of items()) {
      li.click();
      await flush();
      assert.equal($("status").textContent, NO_MID, "the click is refused, explaining why");
    }
    assert.deepEqual(argsOf(tb, "messages.query"), [], "nor a search on click");
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), []);
    assert.deepEqual(tb.mailTab.selected, [2], "selection unchanged");
    assert.equal(popup.page.closed, false);
    assertClean(tb);
  });

  it("adding and deleting a note shows up the next time the list opens", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    tb.selectMessages([1]);
    await flush();
    // Add through the header Note button's editor.
    const header = tb.clickActionButton("messageDisplayAction");
    await flush();
    header.page.document.getElementById("text").value = "Waiting for PO";
    header.page.document.getElementById("done").click();
    await flush();
    let list = await openList(tb);
    assert.deepEqual(list.rows().map((r) => [r.subject, r.note]), [["Invoice 42", "Waiting for PO"]]);
    tb.dismissPopup(list.popup);
    // Delete it the same way.
    const again = tb.clickActionButton("messageDisplayAction");
    await flush();
    again.page.document.getElementById("del").click();
    await flush();
    assert.deepEqual([...tb.storage.keys()].filter((k) => /^(note|info):/.test(k)), [], "note and info both removed");
    list = await openList(tb);
    assert.deepEqual(list.rows(), []);
    assert.equal(list.$("status").textContent, NO_NOTES);
    assertClean(tb);
  });
});
