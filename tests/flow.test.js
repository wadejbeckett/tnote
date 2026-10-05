"use strict";
// Whole user stories across background.js, note.js and display.js, through
// each of the ways the editor can open.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { boot, assertClean, tagsOf, popupText, flush, skip, BASE_URL } = require("./harness/setup.js");
const { SRC } = require("./harness/thunderbird.js");

const TWO = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }];

const ROUTES = [
  { name: "message header panel", config: {}, select: true, kind: "messageDisplayAction" },
  { name: "toolbar button panel", config: {}, select: false, kind: "browserAction" },
  { name: "editor tab in the same window", config: { browserActionButton: false }, select: false, kind: "tab" },
  {
    name: "editor tab when the window manager withholds focus (Cinnamon/X11)",
    config: { browserActionButton: false, windowFocusArrives: false },
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
      if (route.select) tb.selectMessages([id]);

      // Add
      await tb.rightClick([id]);
      assert.equal(tb.menuItems.get("mail-note").title, "Add note…");
      let popup = await openEditor(tb, id);
      assert.equal(popup.kind, route.kind);
      assert.deepEqual(popupText(popup), { subject: "Invoice 42", text: "" });
      typeAndDone(popup, "Not flagged yet: waiting for the signed PO");
      await flush();
      assertEditorGone(tb, popup);
      assert.equal(tb.storage.get("note:msg1@example.com"), "Not flagged yet: waiting for the signed PO");
      assert.deepEqual(tagsOf(tb, id), ["mailnote"]);
      assert.ok(tb.tags.some((x) => x.key === "mailnote" && x.tag === "Note" && x.color === "#2E8B57"));

      // Read: open the message and see the bar.
      const page = tb.selectMessages([id]);
      await flush();
      const { host, root } = page.shadowRoots[0];
      assert.equal(page.document.body.firstChild, host);
      assert.equal(root.querySelector("span").textContent, "Not flagged yet: waiting for the signed PO");

      // Edit
      await tb.rightClick([id]);
      assert.equal(tb.menuItems.get("mail-note").title, "Edit note…");
      tb.mailTab.selected = route.select ? [id] : [];
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

    const { tb, msgs } = await boot(t, { src: dir, messages: TWO, config: { browserActionButton: false, windowFocusArrives: false } });
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
