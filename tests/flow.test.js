"use strict";
// Whole user stories across background.js, note.js and display.js, through
// each of the ways the editor can open.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { boot, assertClean, tagsOf, popupText, advance, flush, skip, BASE_URL } = require("./harness/setup.js");
const { SRC } = require("./harness/thunderbird.js");

const TWO = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }];

// select: the message is selected (displayed) before the right-click.
// paneHidden: the reading pane is hidden while editing.
const ROUTES = [
  { name: "message header panel", config: {}, select: true, kind: "messageDisplayAction" },
  // v0.6.0: a right-click on a message that is not displayed selects it first.
  { name: "message header panel, after selecting the right-clicked message", config: {}, select: false, kind: "messageDisplayAction" },
  // v0.6.0: the toolbar panel is for when nothing can be displayed.
  { name: "toolbar button panel (reading pane hidden)", config: {}, select: false, paneHidden: true, kind: "browserAction" },
  {
    name: "editor tab in the same window",
    config: { browserActionButton: false, messageDisplayActionButton: false },
    select: false,
    kind: "tab",
  },
  {
    name: "editor tab when the window manager withholds focus (Cinnamon/X11)",
    config: { browserActionButton: false, messageDisplayActionButton: false, windowFocusArrives: false },
    select: false,
    kind: "tab",
  },
];

async function openEditor(tb, id) {
  await tb.rightClick([id]);
  const before = tb.popups.length;
  await tb.clickMenuItem("mail-note", [id]);
  await flush();
  assert.equal(tb.popups.length, before + 1, "one editor opened");
  const editor = tb.popups.at(-1);
  // Whatever the route, the editor must be in the window the user is looking at.
  assert.equal(editor.windowId, tb.topWindowId, "editor is in the focused window");
  if (editor.kind === "tab") assert.equal(tb.tabs.get(editor.tabId).active, true, "editor tab is selected");
  assert.equal(editor.url, `${BASE_URL}note.html?id=${id}`, "the editor's URL names the right-clicked message");
  // v0.4.2: no window.focus() (it had no effect in real Thunderbird).
  assert.deepEqual(editor.page.focusLog, ["#text"], "focuses the text box and nothing else");
  assert.equal(editor.page.document.activeElement, editor.page.document.getElementById("text"));
  return editor;
}

function typeAndDone(popup, text) {
  popup.page.document.getElementById("text").value = text;
  popup.page.document.getElementById("done").click();
}

function assertEditorGone(tb, popup) {
  assert.equal(popup.page.closed, true, "editor closed");
  if (popup.kind === "tab") {
    assert.equal(tb.tabs.has(popup.tabId), false, "editor tab closed");
    assert.equal(tb.mailTab.active, true, "back on the message list");
  }
}

describe("add, read, edit and delete a note", { skip }, () => {
  for (const route of ROUTES) {
    it(`via the ${route.name}`, async (t) => {
      const { tb, msgs } = await boot(t, { messages: TWO, config: route.config });
      const id = msgs[0].id;
      if (route.paneHidden) tb.setMessagePaneVisible(false);
      if (route.select) tb.selectMessages([id]);
      else tb.selectMessages([msgs[1].id]); // another message is selected

      // Add
      await tb.rightClick([id]);
      assert.equal(tb.menuItems.get("mail-note").title, "Add note…");
      let popup = await openEditor(tb, id);
      assert.equal(popup.kind, route.kind);
      assert.deepEqual(tb.mailTab.selected, [id], "the right-clicked message ends up selected on every route");
      assert.deepEqual(popupText(popup), { subject: "Invoice 42", text: "" });
      typeAndDone(popup, "Not flagged yet: waiting for the signed PO");
      await flush();
      assertEditorGone(tb, popup);
      assert.equal(tb.storage.get("note:msg1@example.com"), "Not flagged yet: waiting for the signed PO");
      assert.deepEqual(tagsOf(tb, id), ["mailnote"]);
      assert.ok(tb.tags.some((x) => x.key === "mailnote" && x.tag === "Note" && x.color === "#2E8B57"));

      // Read: open the message (showing the reading pane) and see the bar.
      if (route.paneHidden) tb.setMessagePaneVisible(true);
      const page = tb.selectMessages([id]);
      await flush();
      const { host, root } = page.shadowRoots[0];
      assert.equal(page.document.body.firstChild, host);
      assert.equal(root.querySelector("span").textContent, "Not flagged yet: waiting for the signed PO");
      if (route.paneHidden) tb.setMessagePaneVisible(false);

      // Edit
      await tb.rightClick([id]);
      assert.equal(tb.menuItems.get("mail-note").title, "Edit note…");
      tb.mailTab.selected = route.select ? [id] : [msgs[1].id];
      popup = await openEditor(tb, id);
      assert.equal(popup.kind, route.kind);
      assert.deepEqual(popupText(popup), { subject: "Invoice 42", text: "Not flagged yet: waiting for the signed PO" });
      assert.equal(popup.page.document.getElementById("del").hidden, false);
      typeAndDone(popup, "PO arrived; flag it");
      await flush();
      assertEditorGone(tb, popup);
      assert.equal(root.querySelector("span").textContent, "PO arrived; flag it", "bar follows the edit");

      // Delete
      popup = await openEditor(tb, id);
      popup.page.document.getElementById("del").click();
      await flush();
      assertEditorGone(tb, popup);
      assert.equal(tb.storage.size, 0, "note stays deleted after the editor closes");
      assert.deepEqual(tagsOf(tb, id), []);
      assert.equal(host.isConnected, false, "bar removed");
      await tb.rightClick([id]);
      assert.equal(tb.menuItems.get("mail-note").title, "Add note…");

      // The other message was never touched.
      assert.deepEqual(tagsOf(tb, msgs[1].id), []);
      assert.deepEqual(tb.apiCalls("windows.create"), [], "no separate window, on any route");
      assertClean(tb);
    });
  }
});

describe("the All notes list, as the owner uses it (v0.6.0)", { skip }, () => {
  it("find a note, open it on its message, change it, go back, and delete it", async (t) => {
    // The owner's report on v0.5.0: a right-click on a message that was not the
    // displayed one opened the editor at the top right, and the All notes list
    // "did nothing" when clicked and could not delete.
    const messages = [
      { subject: "Invoice 42" },
      { subject: "Quote for racks", author: "Bob Smith <bob@racks.example>", folder: "Archives" },
    ];
    const { tb } = await boot(t, { messages });
    tb.selectMessages([1]);
    await flush();
    // A note added the usual way, on the displayed Inbox message.
    await tb.rightClick([1]);
    await tb.clickMenuItem("mail-note", [1]);
    await flush();
    let panel = tb.popups.at(-1);
    assert.equal(panel.kind, "messageDisplayAction");
    typeAndDone(panel, "Waiting for PO");
    await flush();
    tb.storage.set("note:msg2@example.com", "Chase Bob"); // a note saved before v0.5.0: no details yet
    tb.messages.get(2).keywords.push("mailnote");

    // Open the list: both notes at once, the old one filled in afterwards.
    panel = tb.clickActionButton("browserAction");
    await flush();
    const rows = () => [...panel.page.document.querySelectorAll("#list li")].map((li) => [li.querySelector(".subject").textContent, li.querySelector(".note").textContent]);
    assert.deepEqual(rows(), [
      ["Invoice 42", "Waiting for PO"],
      ["Quote for racks", "Chase Bob"],
    ]);

    // Click the archived note: the mail tab switches folder and shows the
    // message with its bar, and the panel shows the note.
    panel.page.document.querySelectorAll("#list li")[1].click();
    await flush();
    assert.deepEqual([tb.mailTab.folder.name, tb.mailTab.selected], ["Archives", [2]]);
    const page = tb.displayPages.at(-1);
    assert.equal(page.shadowRoots[0].root.querySelector("span").textContent, "Chase Bob");
    assert.equal(panel.page.url, `${BASE_URL}note.html?id=2&from=list`);
    assert.deepEqual(popupText(panel), { subject: "Quote for racks", text: "Chase Bob" });

    // Change it, let it autosave, and go back to the list.
    panel.page.document.getElementById("text").value = "Chase Bob on Friday";
    panel.page.document.getElementById("text").dispatchEvent(new panel.page.window.Event("input", { bubbles: true }));
    await advance(tb, 500);
    assert.equal(page.shadowRoots[0].root.querySelector("span").textContent, "Chase Bob on Friday", "the bar follows");
    panel.page.document.getElementById("back").click();
    await new Promise((r) => setTimeout(r, 10));
    await flush();
    assert.equal(panel.page.url, `${BASE_URL}list.html`);
    assert.deepEqual(rows(), [
      ["Quote for racks", "Chase Bob on Friday"],
      ["Invoice 42", "Waiting for PO"],
    ], "newest first, now that its date is known");

    // Delete it: ✕ arms, a second click deletes; the tag and the bar go too.
    const del = panel.page.document.querySelectorAll("#list li")[0].querySelector("button.del");
    del.click();
    del.click();
    await flush();
    assert.deepEqual(rows(), [["Invoice 42", "Waiting for PO"]]);
    assert.equal(tb.storage.has("note:msg2@example.com"), false);
    assert.equal(tb.storage.has("info:msg2@example.com"), false);
    assert.deepEqual(tagsOf(tb, 2), []);
    assert.equal(page.shadowRoots[0].host.isConnected, false, "bar removed from the open message");
    assert.equal(panel.destroyed, false, "the list stays open");
    assertClean(tb);
  });
});

describe("regression guard", { skip }, () => {
  it("v0.3.1's popup-window fallback leaves the editor in a window that does not have focus on Cinnamon/X11", async (t) => {
    // Re-create v0.3.1's last resort (windows.create popup) in a copy of the
    // current background.js and show the suite's focus check catches it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnote-v031-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.cpSync(SRC, dir, { recursive: true });
    const bgFile = path.join(dir, "background.js");
    const original = fs.readFileSync(bgFile, "utf8");
    // The last-resort line, as of v0.4.1 (the URL already carries ?id=<message>).
    const current = "if (!opened) messenger.tabs.create({ url, windowId: tab?.windowId });";
    const v031 = 'if (!opened) messenger.windows.create({ url, type: "popup", width: 440, height: 300 });';
    // Fail rather than skip: a silently skipped guard guards nothing.
    assert.ok(original.includes(current), "background.js still has the v0.4.1 tabs.create fallback (update this guard if it moved)");
    fs.writeFileSync(bgFile, original.replace(current, v031));

    const { tb, msgs } = await boot(t, {
      src: dir,
      messages: TWO,
      config: { browserActionButton: false, messageDisplayActionButton: false, windowFocusArrives: false },
    });
    await tb.clickMenuItem("mail-note", [msgs[0].id]);
    await flush();
    const editor = tb.popups.at(-1);
    assert.equal(editor.kind, "window");
    assert.equal(editor.url, BASE_URL + "note.html?id=1");
    assert.equal(popupText(editor).subject, "Invoice 42", "the editor did load");
    assert.notEqual(editor.windowId, tb.topWindowId, "but in a window without focus: behind Thunderbird");
    assert.equal(tb.apiCalls("windows.create")[0].result, undefined, "windows.create still waiting for focus");
  });
});
