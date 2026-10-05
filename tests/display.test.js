"use strict";
// display.js (message display script), loaded unmodified into a jsdom message
// document with a content-script API (only content-allowed entries exist).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { boot, pageApi, assertClean, flush, skip } = require("./harness/setup.js");
const { JSDOM } = require("jsdom");

const TWO = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }];

function bar(page) {
  assert.equal(page.shadowRoots.length, 1, "display.js made exactly one shadow host");
  const { host, root } = page.shadowRoots[0];
  return {
    host,
    root,
    shown: host.isConnected,
    text: root.querySelector("span").textContent,
    label: root.querySelector("b").textContent,
  };
}

async function show(tb, id) {
  const page = tb.selectMessages([id]);
  await flush();
  return page;
}

const save = (tb, id, text) => pageApi(tb).runtime.sendMessage({ type: "save", id, text });

describe("note bar (display.js)", { skip }, () => {
  it("renders the note as the first thing in the message, in a closed shadow root", async (t) => {
    const { tb } = await boot(t, { messages: TWO, storage: { "note:msg1@example.com": "Waiting for PO" } });
    const page = await show(tb, 1);
    const b = bar(page);
    assert.equal(b.shown, true);
    assert.equal(page.document.body.firstChild, b.host);
    assert.equal(b.root.mode, "closed");
    assert.equal(b.host.shadowRoot, null, "the email cannot reach into the bar");
    assert.equal(b.label, "Note: ");
    assert.equal(b.text, "Waiting for PO");
    assert.equal(page.document.getElementById("email").textContent, "Dear Alex, the invoice is attached.");
    assertClean(tb);
  });

  it("adds nothing to a message without a note", async (t) => {
    const { tb } = await boot(t, { messages: TWO });
    const page = await show(tb, 1);
    assert.equal(bar(page).shown, false);
    assert.equal(page.document.body.firstElementChild.id, "email");
    assertClean(tb);
  });

  it("shows a note added while the message is open", async (t) => {
    const { tb } = await boot(t, { messages: TWO });
    const page = await show(tb, 1);
    await save(tb, 1, "Call Bob back");
    await flush();
    const b = bar(page);
    assert.equal(b.shown, true);
    assert.equal(b.text, "Call Bob back");
    assertClean(tb);
  });

  it("updates the same bar when the note is edited", async (t) => {
    const { tb } = await boot(t, { messages: TWO, storage: { "note:msg1@example.com": "first" } });
    const page = await show(tb, 1);
    const host = bar(page).host;
    await save(tb, 1, "second");
    await flush();
    assert.equal(bar(page).host, host);
    assert.equal(bar(page).text, "second");
    assert.equal(page.document.body.children.length, 2, "one bar plus the email");
    assertClean(tb);
  });

  it("removes the bar when the note is deleted and brings it back when re-added", async (t) => {
    const { tb } = await boot(t, { messages: TWO, storage: { "note:msg1@example.com": "first" } });
    const page = await show(tb, 1);
    await save(tb, 1, "   ");
    await flush();
    assert.equal(bar(page).shown, false);
    await save(tb, 1, "again");
    await flush();
    assert.equal(bar(page).shown, true);
    assert.equal(bar(page).text, "again");
    assert.equal(page.document.body.firstChild, bar(page).host);
    assert.equal(page.document.body.children.length, 2);
    assertClean(tb);
  });

  it("ignores note changes for other messages", async (t) => {
    const { tb } = await boot(t, { messages: TWO, storage: { "note:msg1@example.com": "mine" } });
    const page = await show(tb, 1);
    await save(tb, 2, "not mine");
    await flush();
    assert.equal(bar(page).text, "mine");
    assertClean(tb);
  });

  it("does nothing (and listens to nothing) when no single message is shown", async (t) => {
    const { tb } = await boot(t, { messages: TWO });
    tb.mailTab.selected = [];
    const page = tb.runDisplayScripts(tb.mailTab);
    await flush();
    assert.equal(page.shadowRoots.length, 0);
    assert.equal(tb.listeners.filter((l) => l.ctx === page.ctx).length, 0);
    assertClean(tb);
  });

  it("renders note text as text, never as markup, keeping line breaks", async (t) => {
    const note = 'line one\n<img src=x onerror="alert(1)">';
    const { tb } = await boot(t, { messages: TWO, storage: { "note:msg1@example.com": note } });
    const page = await show(tb, 1);
    const b = bar(page);
    assert.equal(b.text, note);
    assert.equal(b.root.querySelector("img"), null);
    assert.match(b.root.querySelector("style").textContent, /white-space:\s*pre-wrap/);
    assertClean(tb);
  });

  it("hides the bar when the message is printed (@media print rule in the bar's own style)", async (t) => {
    const { tb } = await boot(t, { messages: TWO, storage: { "note:msg1@example.com": "Private" } });
    const page = await show(tb, 1);
    const { root } = bar(page);
    // jsdom builds no CSSOM for a <style> inside a shadow root, so parse the
    // bar's own style text in a scratch document.
    const scratch = new JSDOM("<style></style>").window.document;
    scratch.querySelector("style").textContent = root.querySelector("style").textContent;
    const rules = [...scratch.querySelector("style").sheet.cssRules];
    const print = rules.filter((r) => r.constructor.name === "CSSMediaRule" && r.media.mediaText === "print");
    assert.equal(print.length, 1, "one print rule");
    const inner = [...print[0].cssRules].map((r) => [r.selectorText, r.style.getPropertyValue("display")]);
    assert.deepEqual(inner, [["div", "none"]], "the bar's div is not displayed in print");
    assert.equal(root.querySelectorAll("div").length, 1, "the rule covers the bar, the only div in the shadow root");
    assert.equal(bar(page).shown, true, "on screen the bar still shows");
    assertClean(tb);
  });

  it("works in a separate message window", async (t) => {
    const { tb } = await boot(t, { messages: TWO, storage: { "note:msg2@example.com": "In a window" } });
    const { page } = tb.openMessageWindow(2);
    await flush();
    assert.equal(bar(page).text, "In a window");
    assertClean(tb);
  });
});
