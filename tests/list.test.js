"use strict";
// list.html + list.js (v0.5.0: the toolbar button's All notes panel), loaded
// unmodified into jsdom as the toolbar button's popup, against the real
// background.js and the schema-checked fake. v0.6.0: a click selects the
// message and opens its note in the same panel; ✕ deletes a note.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { boot, pageApi, assertClean, tagsOf, warnings, advance, flush, skip, BASE_URL } = require("./harness/setup.js");

const LIST_URL = BASE_URL + "list.html";
const INBOX = "account1://INBOX";
const ARCHIVES = "account1://Archives";
const NO_NOTES = "No notes yet. Right-click a message and choose Add note…";
const NO_MATCH = "No notes match.";
const NOT_FOUND = "Couldn't find that message. It may have been deleted, or be in a folder Thunderbird hasn't opened lately; open that folder and try again.";
const NO_MID = "That message has no Message-ID, so it can't be found from here.";
const OPENING = "Opening…";
const SEARCHING = "Searching all folders for this message (once)…";
const FINDING = "Finding message…";
const NO_MID_ROW = "(message without a Message-ID)";
const NOT_FOUND_ROW = "(message not found)"; // v0.6.1
const NO_SUBJECT_ROW = "(no subject)";
// The fake dates message n 2026-10-01 09:0n UTC, so a higher id is newer.
const dateOf = (id) => new Date(Date.UTC(2026, 9, 1, 9, id)).toLocaleDateString();

const MESSAGES = [
  { subject: "Invoice 42", author: "Ann <ann@example.com>" },
  { subject: "Quote for racks", author: "Bob Smith <bob@racks.example>" },
  { subject: "Lunch?", author: "Cat <cat@example.com>", folder: "Archives" },
];
/** The record v0.6.0 keeps next to a note for message n of MESSAGES. */
const infoOf = (id, folderId = id === 3 ? ARCHIVES : INBOX) => ({
  subject: MESSAGES[id - 1].subject,
  author: MESSAGES[id - 1].author,
  date: Date.UTC(2026, 9, 1, 9, id),
  mid: `msg${id}@example.com`,
  folderId,
});
const inFolder = (folderId, mid) => [{ folderId, headerMessageId: mid, messagesPerPage: 1 }];
const everywhere = (mid) => [{ headerMessageId: mid, messagesPerPage: 1 }];

const save = (tb, id, text) => pageApi(tb).runtime.sendMessage({ type: "save", id, text });
const argsOf = (tb, api) => tb.apiCalls(api).map((c) => c.args);
/** Requests the list page sent to the background (describe, reveal, remove), in order. */
const listRequests = (tb) =>
  tb.calls
    .filter((c) => c.api === "runtime.sendMessage" && c.context === "browserAction popup")
    .map((c) => c.args[0])
    .filter((m) => ["describe", "reveal", "remove"].includes(m.type));
/** Lets a followed link (jsdom follows <a href> on a 0 ms Node timer) and its new page load. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 10));
  await flush();
};

/** Clicks the toolbar button and waits for the list to render. */
async function openList(tb, windowId) {
  const popup = tb.clickActionButton("browserAction", windowId);
  assert.equal(popup.url, LIST_URL, "the toolbar button opens the list");
  await flush();
  return listIn(popup);
}

/** Handles for the list page a panel shows now. */
function listIn(popup) {
  const page = popup.page;
  assert.equal(page.url, LIST_URL, "the panel shows the list");
  const doc = page.document;
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
    $("search").dispatchEvent(new page.window.Event("input", { bubbles: true }));
  };
  const key = (el, k) => el.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  /** The ✕ button of row i. */
  const del = (i) => items()[i].querySelector("button.del");
  return { popup, page, doc, $, items, rows, search, key, del };
}

/** The note editor a panel shows now (after a click in the list). */
function editorIn(popup) {
  const doc = popup.page.document;
  return {
    url: popup.page.url,
    subject: doc.getElementById("subject").textContent,
    text: doc.getElementById("text").value,
    back: doc.getElementById("back"),
    doc,
  };
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
    const { $, doc, items, rows, del } = await openList(tb);
    assert.deepEqual(rows(), [
      { subject: "Lunch?", date: dateOf(3), from: "Cat <cat@example.com>", note: "Book a table" },
      { subject: "Quote for racks", date: dateOf(2), from: "Bob Smith <bob@racks.example>", note: "Chase Bob for the rack quote" },
      { subject: "Invoice 42", date: dateOf(1), from: "Ann <ann@example.com>", note: "Waiting for PO 7781" },
    ]);
    assert.ok(dateOf(1), "a date is shown");
    assert.deepEqual(items().map((li) => li.tabIndex), [0, 0, 0], "each note can be reached with Tab");
    assert.deepEqual(items().map((_, i) => [del(i).textContent, del(i).title, del(i).getAttribute("aria-label")]), [
      ["✕", "Delete note", "Delete note"],
      ["✕", "Delete note", "Delete note"],
      ["✕", "Delete note", "Delete note"],
    ]);
    assert.equal($("status").textContent, "");
    assert.equal(doc.activeElement, $("search"), "the search box has the cursor");
    assert.deepEqual(argsOf(tb, "messages.query"), [], "saved notes carry their details: no message search");
    assert.deepEqual(listRequests(tb), [], "and nothing to describe");
    assert.deepEqual(argsOf(tb, "windows.getCurrent"), [[]], "the list asks which window it is in");
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
});

describe("clicking a note: select its message, open its note in the panel (v0.6.0)", { skip }, () => {
  it("selects the message in the current mail tab and shows its note in the same panel, with a way back", async (t) => {
    // v0.5.0 closed the panel after selecting, so the note never showed;
    // the owner reported that clicking a note "does nothing".
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    await save(tb, 1, "PO");
    tb.selectMessages([1]);
    await flush();
    const list = await openList(tb);
    list.items()[0].click(); // Quote for racks (newest)
    assert.equal(list.$("status").textContent, OPENING, "says what it is doing at once");
    await flush();
    assert.deepEqual(listRequests(tb), [{ type: "reveal", mid: "msg2@example.com", windowId: tb.mainWindow.id }]);
    assert.deepEqual(argsOf(tb, "messages.query"), [inFolder(INBOX, "msg2@example.com")], "only the note's folder is searched");
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [2]]]);
    assert.deepEqual([tb.mailTab.folder.name, tb.mailTab.selected], ["Inbox", [2]]);
    assert.equal(barText(tb.displayPages.at(-1)), "Chase Bob", "the message shows with its note bar");
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), [], "no extra tab");
    // The panel stays open and now shows the note.
    const { popup } = list;
    assert.equal(popup.destroyed, false, "the panel is still open");
    assert.deepEqual(popup.pages.map((p) => p.url), [LIST_URL, BASE_URL + "note.html?id=2&from=list"]);
    assert.equal(list.page.closed, true, "the list page unloaded");
    const editor = editorIn(popup);
    assert.deepEqual([editor.subject, editor.text], ["Quote for racks", "Chase Bob"]);
    assert.equal(editor.back.hidden, false, "← All notes is offered");
    assert.equal(editor.doc.activeElement, editor.doc.getElementById("text"));
    assertClean(tb);
  });

  it("a note on a message in another folder switches the mail tab to that folder", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 3, "Book a table");
    assert.equal(tb.mailTab.folder.name, "Inbox");
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query"), [inFolder(ARCHIVES, "msg3@example.com")]);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[tb.mailTab.id, [3]]]);
    assert.equal(tb.mailTab.folder.name, "Archives", "switched folder");
    assert.deepEqual(tb.mailTab.selected, [3]);
    assert.equal(popup.page.url, BASE_URL + "note.html?id=3&from=list");
    assert.equal(editorIn(popup).subject, "Lunch?");
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
    assert.equal(list.popup.page.url, BASE_URL + "note.html?id=1&from=list");
    tb.dismissPopup(list.popup);

    list = await openList(tb);
    list.search("bob");
    list.key(list.$("search"), "Enter");
    await flush();
    assert.deepEqual(tb.mailTab.selected, [2]);
    assert.equal(list.popup.page.url, BASE_URL + "note.html?id=2&from=list");
    tb.dismissPopup(list.popup);

    list = await openList(tb);
    list.search("zebra");
    list.key(list.$("search"), "Enter"); // nothing to open
    list.key(list.$("search"), "a"); // other keys do nothing
    await flush();
    assert.equal(list.popup.page, list.page, "still the list");
    assert.equal(tb.apiCalls("mailTabs.setSelectedMessages").length, 2);
    assertClean(tb);
  });

  it("Enter on a row's ✕ button does not open the note", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 1, "PO");
    const list = await openList(tb);
    list.key(list.del(0), "Enter");
    await flush();
    assert.deepEqual(listRequests(tb), []);
    assert.equal(list.popup.page, list.page);
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
    assert.deepEqual(listRequests(tb), [{ type: "reveal", mid: "msg2@example.com", windowId: second.window.id }]);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [[second.tab.id, [2]]]);
    assert.deepEqual(second.tab.selected, [2]);
    assert.deepEqual(tb.mailTab.selected, [1], "the first window is untouched");
    assert.equal(popup.page.url, BASE_URL + "note.html?id=2&from=list");
    assert.equal(popup.windowId, second.window.id, "the note opens in the same panel");
    assertClean(tb);
  });

  it("with no mail tab in front (a message tab is), opens the note in the panel and selects nothing (v0.6.0)", async (t) => {
    // v0.5.0 opened the message in another tab; v0.6.0's panel shows the note itself.
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    const msgTab = tb.addTab(tb.mainWindow.id, "messageDisplay", { selected: [1] });
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), [], "no mail tab to select in");
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), []);
    assert.equal(tb.activeTab(tb.mainWindow.id), msgTab, "the message tab stays in front");
    assert.deepEqual(tb.mailTab.selected, [], "the mail tab is untouched");
    assert.equal(popup.page.url, BASE_URL + "note.html?id=2&from=list");
    assert.deepEqual([editorIn(popup).subject, editorIn(popup).text], ["Quote for racks", "Chase Bob"]);
    assertClean(tb);
  });

  it("when the mail tab cannot show the message's folder, the note still opens in the panel and the failure is logged", async (t) => {
    // ext-mailTabs.js:715-720: no row for the folder in any enabled folder mode.
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 3, "Book a table");
    tb.unviewable.add(ARCHIVES);
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.match(tb.apiCalls("mailTabs.setSelectedMessages")[0].rejected, /not viewable in any of the enabled folder modes/);
    assert.deepEqual(warnings(tb), ["tNOTE: Error: Folder of the requested message(s) is not viewable in any of the enabled folder modes"]);
    assert.equal(tb.mailTab.folder.name, "Inbox");
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), []);
    assert.equal(popup.page.url, BASE_URL + "note.html?id=3&from=list");
    assert.equal(editorIn(popup).subject, "Lunch?");
    assertClean(tb);
  });

  it("when selecting fails for any other reason, the note still opens in the panel", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 1, "PO");
    tb.faults["mailTabs.setSelectedMessages"] = new Error("view not ready");
    const { popup, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.deepEqual(warnings(tb), ["tNOTE: Error: view not ready"]);
    assert.equal(popup.page.url, BASE_URL + "note.html?id=1&from=list");
    assert.equal(editorIn(popup).text, "PO");
    assertClean(tb);
  });

  it("a note whose message was deleted is still listed; clicking it says so and keeps the list open", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    tb.deleteMessage(2);
    const { popup, page, $, items, rows } = await openList(tb);
    assert.deepEqual(rows(), [{ subject: "Quote for racks", date: dateOf(2), from: "Bob Smith <bob@racks.example>", note: "Chase Bob" }]);
    items()[0].click();
    assert.equal($("status").textContent, OPENING);
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query"), [inFolder(INBOX, "msg2@example.com"), everywhere("msg2@example.com")], "its folder, then everywhere");
    assert.deepEqual(tb.apiCalls("messages.query").map((c) => c.result.messages.length), [0, 0]);
    assert.equal($("status").textContent, NOT_FOUND);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    assert.deepEqual(argsOf(tb, "messageDisplay.open"), []);
    assert.equal(popup.page, page, "the list stays");
    assert.equal(page.closed, false);
    assertClean(tb);
  });

  it("a failing message search counts as not found", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    tb.faults["messages.query"] = new Error("search failed");
    const { popup, page, $, items } = await openList(tb);
    items()[0].click();
    await flush();
    assert.equal(tb.apiCalls("messages.query").length, 2);
    assert.equal($("status").textContent, NOT_FOUND);
    assert.equal(popup.page, page);
    assertClean(tb);
  });

  it("a note without a folder on record says it is searching all folders, once; then its folder is known", async (t) => {
    // Notes saved by v0.5.0 have a record without the folder.
    const { folderId, ...v050 } = infoOf(3);
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg3@example.com": "Book a table", "info:msg3@example.com": v050 } });
    assert.equal(folderId, ARCHIVES);
    let list = await openList(tb);
    assert.deepEqual(listRequests(tb), [], "the row has its details, so nothing to describe");
    list.items()[0].click();
    assert.equal(list.$("status").textContent, SEARCHING);
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query"), [everywhere("msg3@example.com")]);
    assert.deepEqual(tb.storage.get("info:msg3@example.com"), infoOf(3), "the folder is recorded");
    assert.equal(list.popup.page.url, BASE_URL + "note.html?id=3&from=list");
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    list.items()[0].click();
    assert.equal(list.$("status").textContent, OPENING);
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query")[1], inFolder(ARCHIVES, "msg3@example.com"));
    assertClean(tb);
  });

  it("← All notes in the opened note goes back to the list in the same panel, which shows the edit", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    await save(tb, 1, "PO");
    const list = await openList(tb);
    list.items()[0].click();
    await flush();
    const { popup } = list;
    const editor = editorIn(popup);
    assert.equal(editor.back.getAttribute("href"), "list.html");
    editor.doc.getElementById("text").value = "Chase Bob on Friday";
    editor.doc.getElementById("text").dispatchEvent(new popup.page.window.Event("input", { bubbles: true }));
    await advance(tb, 500); // autosaved
    assert.equal(tb.storage.get("note:msg2@example.com"), "Chase Bob on Friday");
    editor.back.click();
    await settle();
    assert.equal(popup.destroyed, false);
    assert.deepEqual(popup.pages.map((p) => p.url), [LIST_URL, BASE_URL + "note.html?id=2&from=list", LIST_URL]);
    const back = listIn(popup);
    assert.deepEqual(back.rows().map((r) => [r.subject, r.note]), [
      ["Quote for racks", "Chase Bob on Friday"],
      ["Invoice 42", "PO"],
    ]);
    assert.equal(back.doc.activeElement, back.$("search"));
    assertClean(tb);
  });

  it("← All notes right after typing still saves the typed text (pagehide)", async (t) => {
    // The save from pagehide and the list page's first read race each other;
    // in the fake the list reads first and shows the text as it was, and it
    // does not listen for changes. Only the save itself is asserted here.
    const { tb } = await boot(t, { messages: MESSAGES });
    await save(tb, 2, "Chase Bob");
    const list = await openList(tb);
    list.items()[0].click();
    await flush();
    const editor = editorIn(list.popup);
    editor.doc.getElementById("text").value = "Chase Bob on Friday"; // typed, autosave not yet due
    editor.back.click();
    await settle();
    assert.equal(list.popup.page.url, LIST_URL);
    assert.equal(tb.storage.get("note:msg2@example.com"), "Chase Bob on Friday", "leaving the note saved it");
    assertClean(tb);
  });
});

describe("notes without details: listed at once, filled in afterwards (v0.6.0)", { skip }, () => {
  it("rows show \"Finding message…\" before any lookup has answered, and are filled in as each answers", async (t) => {
    // v0.5.0 looked each one up before showing the list at all, which on a
    // large mailbox meant a list that never appeared. v0.6.1 looks them up one
    // at a time: each all-folders search holds Thunderbird up while it runs.
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: {
        "note:msg2@example.com": "Chase Bob",
        "note:msg3@example.com": "Book a table",
        "note:msg1@example.com": "PO",
        "info:msg1@example.com": infoOf(1),
      },
    });
    const first = tb.hold("messages.query");
    const { $, doc, rows, search } = await openList(tb);
    assert.deepEqual(rows(), [
      { subject: "Invoice 42", date: dateOf(1), from: "Ann <ann@example.com>", note: "PO" },
      { subject: FINDING, date: "", from: "", note: "Chase Bob" },
      { subject: FINDING, date: "", from: "", note: "Book a table" },
    ]);
    assert.equal($("status").textContent, "");
    assert.equal(doc.activeElement, $("search"), "ready to search");
    assert.deepEqual(listRequests(tb), [{ type: "describe", mid: "msg2@example.com" }], "one lookup at a time");
    assert.deepEqual(tb.apiCalls("messages.query").map((c) => c.result), [undefined], "asked, not answered yet");
    const second = tb.hold("messages.query"); // holds only the lookups asked from now on
    first.release();
    await flush();
    assert.deepEqual(rows().map((r) => r.subject), ["Invoice 42", "Quote for racks", FINDING], "the first is filled in");
    assert.deepEqual(listRequests(tb), [
      { type: "describe", mid: "msg2@example.com" },
      { type: "describe", mid: "msg3@example.com" },
    ], "and only then is the second asked for");
    assert.deepEqual(tb.apiCalls("messages.query").map((c) => c.result === undefined), [false, true]);
    second.release();
    await flush();
    // Filled in where they are: the list is sorted once, when it opens.
    assert.deepEqual(rows(), [
      { subject: "Invoice 42", date: dateOf(1), from: "Ann <ann@example.com>", note: "PO" },
      { subject: "Quote for racks", date: dateOf(2), from: "Bob Smith <bob@racks.example>", note: "Chase Bob" },
      { subject: "Lunch?", date: dateOf(3), from: "Cat <cat@example.com>", note: "Book a table" },
    ]);
    search("cat@");
    assert.deepEqual(rows().map((r) => r.subject), ["Lunch?"], "search finds a filled-in row by its author");
    assert.deepEqual(argsOf(tb, "messages.query"), [everywhere("msg2@example.com"), everywhere("msg3@example.com")]);
    assertClean(tb);
  });

  it("fills in the details of notes saved before v0.5.0 once, and remembers each message's folder", async (t) => {
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg2@example.com": "Chase Bob", "note:msg3@example.com": "Book a table" },
    });
    let list = await openList(tb);
    assert.deepEqual(list.rows(), [
      { subject: "Quote for racks", date: dateOf(2), from: "Bob Smith <bob@racks.example>", note: "Chase Bob" },
      { subject: "Lunch?", date: dateOf(3), from: "Cat <cat@example.com>", note: "Book a table" },
    ]);
    assert.deepEqual(argsOf(tb, "messages.query"), [everywhere("msg2@example.com"), everywhere("msg3@example.com")]);
    assert.deepEqual(tb.storage.get("info:msg2@example.com"), infoOf(2));
    assert.deepEqual(tb.storage.get("info:msg3@example.com"), infoOf(3));
    assert.equal(tb.storage.get("note:msg2@example.com"), "Chase Bob", "the note itself is untouched");
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    assert.deepEqual(list.rows().map((r) => r.subject), ["Lunch?", "Quote for racks"], "newest first now that dates are known");
    assert.equal(tb.apiCalls("messages.query").length, 2, "the second opening searches for nothing");
    // A click goes straight to the recorded folder.
    list.items()[1].click();
    assert.equal(list.$("status").textContent, OPENING);
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query")[2], inFolder(INBOX, "msg2@example.com"));
    assert.deepEqual(tb.mailTab.selected, [2]);
    assert.equal(list.popup.page.url, BASE_URL + "note.html?id=2&from=list");
    assertClean(tb);
  });

  it("an old note whose message is gone is listed last as \"(message not found)\", recorded so, and not searched for again (v0.6.1)", async (t) => {
    // v0.5.0 showed "(no subject)"; v0.6.0 left the row on "Finding message…"
    // for good, and searched every folder for it each time the list opened.
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:gone@example.com": "Orphan", "note:msg1@example.com": "PO", "info:msg1@example.com": infoOf(1) },
    });
    let list = await openList(tb);
    assert.deepEqual(argsOf(tb, "messages.query"), [everywhere("gone@example.com")]);
    assert.deepEqual(tb.storage.get("info:gone@example.com"), { mid: "gone@example.com", missing: true });
    assert.equal(tb.storage.get("note:gone@example.com"), "Orphan", "the note itself is untouched");
    assert.deepEqual(list.rows(), [
      { subject: "Invoice 42", date: dateOf(1), from: "Ann <ann@example.com>", note: "PO" },
      { subject: NOT_FOUND_ROW, date: "", from: "", note: "Orphan" },
    ]);
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    assert.deepEqual(list.rows().map((r) => r.subject), ["Invoice 42", NOT_FOUND_ROW], "shown so at once the next time");
    assert.deepEqual(listRequests(tb), [{ type: "describe", mid: "gone@example.com" }], "the second opening asks for nothing");
    assert.equal(tb.apiCalls("messages.query").length, 1, "and searches nothing");
    // A click still looks for it, in all folders (there is no folder on record).
    list.items()[1].click();
    assert.equal(list.$("status").textContent, SEARCHING);
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query").slice(1), [everywhere("gone@example.com")]);
    assert.equal(list.$("status").textContent, NOT_FOUND);
    assert.equal(list.popup.page, list.page, "the list stays");
    assert.deepEqual(tb.storage.get("info:gone@example.com"), { mid: "gone@example.com", missing: true });
    assertClean(tb);
  });

  it("notes on messages without a Message-ID (\"id:\" keys) are listed, but cannot be jumped to", async (t) => {
    // Their key is a per-session message id, so nothing looks them up. v0.6.1
    // labels every such row "(message without a Message-ID)", even one whose
    // record has a subject (v0.6.0 showed the subject there).
    const { tb } = await boot(t, { messages: [{ subject: "No id", headerMessageId: "" }, { subject: "Also no id", headerMessageId: "" }] });
    await save(tb, 1, "Saved with v0.5.0");
    tb.storage.set("note:id:2", "Saved before v0.5.0");
    tb.selectMessages([2]);
    await flush();
    const { popup, page, $, rows, items } = await openList(tb);
    assert.deepEqual(rows(), [
      { subject: NO_MID_ROW, date: dateOf(1), from: "Ann <ann@example.com>", note: "Saved with v0.5.0" },
      { subject: NO_MID_ROW, date: "", from: "", note: "Saved before v0.5.0" },
    ]);
    assert.deepEqual(listRequests(tb), [], "no describe for an id: key");
    for (const li of items()) {
      li.click();
      await flush();
      assert.equal($("status").textContent, NO_MID, "the click is refused, explaining why");
    }
    assert.deepEqual(listRequests(tb), [], "nor a reveal on click");
    assert.deepEqual(argsOf(tb, "messages.query"), []);
    assert.deepEqual(argsOf(tb, "mailTabs.setSelectedMessages"), []);
    assert.deepEqual(tb.mailTab.selected, [2], "selection unchanged");
    assert.equal(popup.page, page);
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
    assert.equal(again.page.document.getElementById("back").hidden, true, "no way back to a list it did not come from");
    again.page.document.getElementById("del").click();
    await flush();
    assert.deepEqual([...tb.storage.keys()].filter((k) => /^(note|info):/.test(k)), [], "note and info both removed");
    list = await openList(tb);
    assert.deepEqual(list.rows(), []);
    assert.equal(list.$("status").textContent, NO_NOTES);
    assertClean(tb);
  });
});

describe("deleting from the list: ✕ arms, a second click deletes (v0.6.0)", { skip }, () => {
  const tagged = MESSAGES.map((m) => ({ ...m, tags: ["mailnote"] }));
  const STORAGE = {
    "note:msg1@example.com": "PO",
    "info:msg1@example.com": infoOf(1),
    "note:msg2@example.com": "Chase Bob",
    "info:msg2@example.com": infoOf(2),
    "note:msg3@example.com": "Book a table",
    "info:msg3@example.com": infoOf(3),
  };

  it("the first click arms the button and does nothing else; the second removes the row at once, then the note, its record and the tag", async (t) => {
    const { tb } = await boot(t, { messages: tagged.map((m, i) => (i === 1 ? { ...m, tags: ["$label2", "mailnote"] } : m)), storage: STORAGE });
    const list = await openList(tb);
    const { del, rows, $ } = list;
    assert.deepEqual(rows().map((r) => r.subject), ["Lunch?", "Quote for racks", "Invoice 42"]);
    const button = del(1); // Quote for racks
    button.click();
    assert.deepEqual([button.textContent, button.classList.contains("armed")], ["Delete", true]);
    assert.deepEqual([del(0).textContent, del(2).textContent], ["✕", "✕"], "only that row is armed");
    await flush();
    assert.deepEqual(listRequests(tb), [], "arming sends nothing, and does not open the note");
    assert.equal($("status").textContent, "");
    assert.equal(list.popup.page, list.page);
    assert.equal(tb.storage.get("note:msg2@example.com"), "Chase Bob");
    // Second click: the row goes before the background has done anything.
    const held = tb.hold("storage.local.get");
    button.click();
    assert.deepEqual(rows().map((r) => r.subject), ["Lunch?", "Invoice 42"], "the row is gone at once");
    assert.equal($("status").textContent, "");
    await flush();
    assert.deepEqual(listRequests(tb), [{ type: "remove", key: "msg2@example.com" }]);
    assert.equal(tb.storage.get("note:msg2@example.com"), "Chase Bob", "the background is still waiting");
    held.release();
    await flush();
    assert.equal(tb.storage.has("note:msg2@example.com"), false);
    assert.equal(tb.storage.has("info:msg2@example.com"), false);
    assert.deepEqual(argsOf(tb, "messages.query"), [[{ folderId: INBOX, headerMessageId: "msg2@example.com", messagesPerPage: 1 }]], "found via the recorded folder");
    assert.deepEqual(tagsOf(tb, 2), ["$label2"], "the Note tag is removed, other tags kept");
    assert.deepEqual([tagsOf(tb, 1), tagsOf(tb, 3)], [["mailnote"], ["mailnote"]]);
    assert.deepEqual([...tb.storage.keys()].sort(), ["info:msg1@example.com", "info:msg3@example.com", "note:msg1@example.com", "note:msg3@example.com"]);
    assert.equal($("status").textContent, "");
    assertClean(tb);
  });

  it("the armed button goes back to ✕ after 3 s, and a click then arms it again", async (t) => {
    const { tb } = await boot(t, { messages: tagged, storage: STORAGE });
    const { del } = await openList(tb);
    del(0).click();
    await advance(tb, 2999);
    assert.deepEqual([del(0).textContent, del(0).classList.contains("armed")], ["Delete", true], "still armed at 2999 ms");
    await advance(tb, 1);
    assert.deepEqual([del(0).textContent, del(0).classList.contains("armed")], ["✕", false], "disarmed at 3000 ms");
    del(0).click(); // arms again, deletes nothing
    await flush();
    assert.equal(del(0).textContent, "Delete");
    assert.deepEqual(listRequests(tb), []);
    assert.equal(tb.storage.get("note:msg3@example.com"), "Book a table");
    del(0).click();
    await flush();
    assert.deepEqual(listRequests(tb), [{ type: "remove", key: "msg3@example.com" }]);
    assert.equal(tb.storage.has("note:msg3@example.com"), false);
    assertClean(tb);
  });

  it("deleting keeps the search, and deleting the last note says there are none", async (t) => {
    const { tb } = await boot(t, { messages: tagged, storage: STORAGE });
    const { del, rows, search, $ } = await openList(tb);
    search("bob");
    assert.deepEqual(rows().map((r) => r.subject), ["Quote for racks"]);
    del(0).click();
    del(0).click();
    assert.deepEqual(rows(), []);
    assert.equal($("status").textContent, NO_MATCH, "the other notes are still there, just not matching");
    search("");
    assert.deepEqual(rows().map((r) => r.subject), ["Lunch?", "Invoice 42"]);
    for (let i = 0; i < 2; i++) {
      del(0).click();
      del(0).click();
    }
    assert.equal($("status").textContent, NO_NOTES);
    await flush();
    assert.deepEqual([...tb.storage.keys()].filter((k) => /^(note|info):/.test(k)), []);
    assert.deepEqual([tagsOf(tb, 1), tagsOf(tb, 2), tagsOf(tb, 3)], [[], [], []]);
    assertClean(tb);
  });

  it("a note whose message can't be found is still deleted", async (t) => {
    const { tb } = await boot(t, { messages: tagged, storage: STORAGE });
    tb.deleteMessage(2);
    const { del, rows } = await openList(tb);
    del(1).click();
    del(1).click();
    await flush();
    assert.deepEqual(rows().map((r) => r.subject), ["Lunch?", "Invoice 42"]);
    assert.equal(tb.storage.has("note:msg2@example.com"), false);
    assert.equal(tb.storage.has("info:msg2@example.com"), false);
    assert.deepEqual(argsOf(tb, "messages.query"), [inFolder(INBOX, "msg2@example.com"), everywhere("msg2@example.com")]);
    assert.deepEqual(argsOf(tb, "messages.update"), []);
    assertClean(tb);
  });

  it("a note on a message moved since is deleted and the moved message untagged", async (t) => {
    const { tb } = await boot(t, { messages: tagged, storage: STORAGE });
    const moved = tb.moveMessage(1, "Archives");
    const { del } = await openList(tb);
    del(2).click(); // Invoice 42
    del(2).click();
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query"), [inFolder(INBOX, "msg1@example.com"), everywhere("msg1@example.com")]);
    assert.deepEqual(tagsOf(tb, moved.id), []);
    assert.equal(tb.storage.has("info:msg1@example.com"), false, "no record written back");
    assertClean(tb);
  });

  it("a delete that fails says so", async (t) => {
    const { tb } = await boot(t, { messages: tagged, storage: STORAGE });
    tb.faults["storage.local.remove"] = new Error("disk full");
    const { del, $ } = await openList(tb);
    del(0).click();
    del(0).click();
    await flush();
    assert.equal($("status").textContent, "Couldn't delete the note: disk full");
    assert.equal(tb.storage.get("note:msg3@example.com"), "Book a table");
    assertClean(tb);
  });

  it("a note on a message without a Message-ID (\"id:\" key) is deleted too, without searching (v0.6.1)", async (t) => {
    // v0.6.0 sent the row's Message-ID (null) and removed "note:null", so the
    // note came back on the next opening.
    const { tb } = await boot(t, { messages: [{ subject: "No id", headerMessageId: "", tags: ["mailnote"] }] });
    await save(tb, 1, "Saved with v0.5.0");
    tb.storage.set("note:id:7", "Saved before v0.5.0"); // no record, and no message 7 this session
    assert.deepEqual([...tb.storage.keys()].sort(), ["info:id:1", "note:id:1", "note:id:7"]);
    let list = await openList(tb);
    assert.deepEqual(list.rows().map((r) => [r.subject, r.note]), [
      [NO_MID_ROW, "Saved with v0.5.0"],
      [NO_MID_ROW, "Saved before v0.5.0"],
    ]);
    for (let i = 0; i < 2; i++) {
      list.del(0).click();
      list.del(0).click();
    }
    await flush();
    assert.deepEqual(list.rows(), [], "gone from the list");
    assert.deepEqual(listRequests(tb), [
      { type: "remove", key: "id:1" },
      { type: "remove", key: "id:7" },
    ]);
    assert.deepEqual(argsOf(tb, "storage.local.remove"), [[["note:id:1", "info:id:1"]], [["note:id:7", "info:id:7"]]]);
    assert.deepEqual([...tb.storage.keys()].filter((k) => /^(note|info):/.test(k)), [], "and from storage, so it does not come back");
    assert.deepEqual(argsOf(tb, "messages.query"), [], "nothing searched for");
    assert.deepEqual(argsOf(tb, "messages.update").slice(1), [], "and no tag change after the save's own");
    assert.equal(list.$("status").textContent, NO_NOTES);
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    assert.deepEqual(list.rows(), []);
    assertClean(tb);
  });
});

describe("rows filled in one at a time, in place (v0.6.1)", { skip }, () => {
  /** Two notes saved before v0.5.0 (no record), after one with its record. */
  const OLD_NOTES = {
    "note:msg1@example.com": "PO",
    "info:msg1@example.com": infoOf(1),
    "note:msg2@example.com": "Chase Bob",
    "note:msg3@example.com": "Book a table",
  };

  it("an armed ✕, the status line and a focused row all survive a lookup answering", async (t) => {
    // v0.6.0 redrew the whole list when a lookup answered: every ✕ went back to
    // unarmed (so the second click armed it again instead of deleting), the
    // status line was cleared and keyboard focus was lost.
    const { tb } = await boot(t, {
      messages: [...MESSAGES, { subject: "No id", headerMessageId: "" }],
      storage: { ...OLD_NOTES, "note:id:4": "Saved before v0.5.0" },
    });
    const held = tb.hold("messages.query");
    const list = await openList(tb);
    const { $, del, items, rows } = list;
    assert.deepEqual(rows().map((r) => r.subject), ["Invoice 42", FINDING, FINDING, NO_MID_ROW]);
    items()[3].click(); // a row that cannot be opened says why
    assert.equal($("status").textContent, NO_MID);
    const armed = del(0);
    armed.click();
    const focused = items()[3];
    focused.focus();
    const before = items();
    held.release();
    await flush();
    assert.deepEqual(rows().map((r) => r.subject), ["Invoice 42", "Quote for racks", "Lunch?", NO_MID_ROW], "both filled in");
    assert.deepEqual(items(), before, "in the same rows");
    assert.deepEqual([armed.isConnected, armed.textContent, armed.classList.contains("armed")], [true, "Delete", true], "still armed");
    assert.equal($("status").textContent, NO_MID, "the status line is kept");
    assert.equal(list.doc.activeElement, focused, "focus is kept");
    armed.click(); // so this click deletes
    await flush();
    assert.deepEqual(rows().map((r) => r.subject), ["Quote for racks", "Lunch?", NO_MID_ROW]);
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assertClean(tb);
  });

  it("a lookup that fails leaves its row on \"Finding message…\", the next lookup still runs, and the next opening tries again", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: OLD_NOTES });
    let failures = 1; // the first record write (msg2's) fails, so its describe rejects
    tb.faults["storage.local.set"] = () => (failures-- > 0 ? new Error("disk full") : undefined);
    let list = await openList(tb);
    assert.deepEqual(list.rows().map((r) => r.subject), ["Invoice 42", FINDING, "Lunch?"]);
    assert.deepEqual(tb.apiCalls("storage.local.set").map((c) => c.rejected), ["disk full", undefined]);
    assert.equal(tb.storage.has("info:msg2@example.com"), false);
    assert.equal(list.$("status").textContent, "");
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    assert.deepEqual(list.rows().map((r) => r.subject), ["Lunch?", "Invoice 42", "Quote for racks"]);
    assert.deepEqual(listRequests(tb).map((r) => r.mid), ["msg2@example.com", "msg3@example.com", "msg2@example.com"]);
    assertClean(tb);
  });

  it("a row hidden by the search while its lookup answers shows its details once the search is cleared", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: OLD_NOTES });
    const held = tb.hold("messages.query");
    const { rows, search } = await openList(tb);
    search("table"); // only Book a table (msg3) shows; msg2 is being looked up
    assert.deepEqual(rows().map((r) => [r.subject, r.note]), [[FINDING, "Book a table"]]);
    held.release();
    await flush();
    assert.deepEqual(rows(), [{ subject: "Lunch?", date: dateOf(3), from: "Cat <cat@example.com>", note: "Book a table" }]);
    search("");
    assert.deepEqual(rows().map((r) => r.subject), ["Invoice 42", "Quote for racks", "Lunch?"]);
    search("bob smith");
    assert.deepEqual(rows().map((r) => r.subject), ["Quote for racks"], "found by its looked-up author");
    assertClean(tb);
  });

  it("a note whose message turns up later: clicking \"(message not found)\" opens it, and the list then shows its details", async (t) => {
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:late@example.com": "Reply due", "info:late@example.com": { mid: "late@example.com", missing: true } } });
    let list = await openList(tb);
    assert.deepEqual(list.rows(), [{ subject: NOT_FOUND_ROW, date: "", from: "", note: "Reply due" }]);
    assert.deepEqual(listRequests(tb), [], "a missing record counts as described");
    const late = tb.addMessage({ subject: "Late reply", author: "Dan <dan@example.com>", headerMessageId: "late@example.com", folder: "Archives" });
    list.items()[0].click();
    assert.equal(list.$("status").textContent, SEARCHING);
    await flush();
    assert.deepEqual(argsOf(tb, "messages.query"), [everywhere("late@example.com")]);
    assert.deepEqual([tb.mailTab.folder.name, tb.mailTab.selected], ["Archives", [late.id]]);
    assert.equal(list.popup.page.url, `${BASE_URL}note.html?id=${late.id}&from=list`);
    const record = { subject: "Late reply", author: "Dan <dan@example.com>", date: Date.UTC(2026, 9, 1, 9, late.id), mid: "late@example.com", folderId: ARCHIVES };
    assert.deepEqual(tb.storage.get("info:late@example.com"), record, "no longer missing");
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    assert.deepEqual(list.rows(), [{ subject: "Late reply", date: dateOf(late.id), from: "Dan <dan@example.com>", note: "Reply due" }]);
    assert.deepEqual(listRequests(tb).filter((r) => r.type === "describe"), []);
    assertClean(tb);
  });

  it("a message with an empty subject shows \"(no subject)\" once looked up, and is not looked up again", async (t) => {
    // v0.6.0 took an empty subject for details not yet known, so it searched
    // every folder for such a note each time the list opened.
    const { tb } = await boot(t, { messages: [{ subject: "", author: "Ann <ann@example.com>" }], storage: { "note:msg1@example.com": "No subject line" } });
    let list = await openList(tb);
    assert.deepEqual(list.rows(), [{ subject: NO_SUBJECT_ROW, date: dateOf(1), from: "Ann <ann@example.com>", note: "No subject line" }]);
    assert.deepEqual(argsOf(tb, "messages.query"), [everywhere("msg1@example.com")]);
    assert.equal(tb.storage.get("info:msg1@example.com").subject, "");
    tb.dismissPopup(list.popup);
    list = await openList(tb);
    assert.deepEqual(list.rows().map((r) => r.subject), [NO_SUBJECT_ROW]);
    assert.deepEqual(listRequests(tb), [{ type: "describe", mid: "msg1@example.com" }], "no second lookup");
    assert.equal(tb.apiCalls("messages.query").length, 1);
    assertClean(tb);
  });

  it("a row's Message-ID comes from its storage key, not from its record", async (t) => {
    // The record is spread first, so a record's mid (empty for a message
    // without a Message-ID) cannot replace the key's.
    const { tb } = await boot(t, {
      messages: MESSAGES,
      storage: { "note:msg2@example.com": "Chase Bob", "info:msg2@example.com": { ...infoOf(2), mid: "" } },
    });
    const { rows, items } = await openList(tb);
    assert.deepEqual(rows().map((r) => r.subject), ["Quote for racks"]);
    items()[0].click();
    await flush();
    assert.deepEqual(listRequests(tb), [{ type: "reveal", mid: "msg2@example.com", windowId: tb.mainWindow.id }]);
    assert.deepEqual(tb.mailTab.selected, [2]);
    assertClean(tb);
  });

  it("a note deleted while it waits for its lookup is not looked up, and leaves no record behind", async (t) => {
    // The list builds its queue of lookups when it opens. A note deleted before
    // its turn should drop out of it: each all-folders search holds Thunderbird
    // up, and an answer for a deleted note writes an info: record that no note
    // goes with.
    const { tb } = await boot(t, { messages: MESSAGES, storage: { "note:msg2@example.com": "Chase Bob", "note:msg3@example.com": "Book a table" } });
    const held = tb.hold("messages.query");
    const { rows, del } = await openList(tb);
    assert.deepEqual(listRequests(tb), [{ type: "describe", mid: "msg2@example.com" }]);
    del(1).click(); // Book a table, still waiting for its turn
    del(1).click();
    await flush();
    assert.deepEqual(rows().map((r) => r.note), ["Chase Bob"]);
    held.release();
    await flush();
    assert.deepEqual(rows().map((r) => r.subject), ["Quote for racks"]);
    assert.deepEqual(listRequests(tb).filter((r) => r.type === "describe"), [{ type: "describe", mid: "msg2@example.com" }], "the deleted note is not looked up");
    assert.deepEqual([...tb.storage.keys()].sort(), ["info:msg2@example.com", "note:msg2@example.com"], "no record left for the deleted note");
    assertClean(tb);
  });
});
