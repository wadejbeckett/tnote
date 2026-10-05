"use strict";
// note.html + note.js (the editor), loaded unmodified into jsdom, talking to the
// real background.js through the schema-checked fake.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { boot, assertClean, tagsOf, advance, flush, skip } = require("./harness/setup.js");
const { readSource } = require("./harness/thunderbird.js");

const THREE = [{ subject: "Invoice 42" }, { subject: "Quote for racks" }, { subject: "Lunch?" }];
const SELECT_ONE = "Select one message to add a note.";

async function editor(tb, url = "note.html?id=1") {
  const page = tb.loadExtensionPage(url, { name: "editor" });
  await flush();
  const $ = (id) => page.document.getElementById(id);
  const key = (opts) => {
    $("text").dispatchEvent(new page.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts }));
  };
  /** Types into the textarea the way a user does: the value changes, then "input" fires. */
  const type = (value) => {
    $("text").value = value;
    $("text").dispatchEvent(new page.window.Event("input", { bubbles: true }));
  };
  return { page, $, key, type };
}

const saves = (tb) => tb.apiCalls("runtime.sendMessage").map((c) => c.args[0]).filter((m) => m.type === "save");

describe("note editor (note.html + note.js)", { skip }, () => {
  it("shows the subject and the existing note, offers Delete note and Done, focuses the text", async (t) => {
    const { tb } = await boot(t, { messages: THREE, storage: { "note:msg2@example.com": "Chase Bob" } });
    const { page, $ } = await editor(tb, "note.html?id=2");
    assert.equal($("subject").textContent, "Quote for racks");
    assert.equal($("text").value, "Chase Bob");
    assert.equal($("del").hidden, false);
    assert.deepEqual([...page.document.querySelectorAll("button")].map((b) => [b.id, b.textContent]), [
      ["del", "Delete note"],
      ["done", "Done"],
    ]);
    assert.equal($("cancel"), null, "no Cancel button");
    assert.equal($("save"), null, "no Save button");
    assert.equal($("status").textContent, "");
    assert.equal($("text").disabled, false);
    assert.equal(page.document.activeElement, $("text"));
    // Only the text box is focused. v0.4.1 also called window.focus(), which a
    // real-Thunderbird run showed has no effect; v0.4.2 dropped it.
    assert.deepEqual(page.focusLog, ["#text"]);
    assert.equal(page.closed, false);
    assertClean(tb);
  });

  it("hides Delete when there is no note yet", async (t) => {
    const { tb } = await boot(t);
    const { $ } = await editor(tb);
    assert.equal($("text").value, "");
    assert.equal($("del").hidden, true);
    assertClean(tb);
  });

  it("Done saves the typed text for the loaded message, then closes", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    const { page, $ } = await editor(tb, "note.html?id=3");
    $("text").value = "Booked for Friday";
    $("done").click();
    assert.deepEqual(saves(tb), [{ type: "save", id: 3, text: "Booked for Friday" }], "the save is sent first");
    assert.equal(page.closeRequested, false, "close only after the save has answered");
    await flush();
    assert.deepEqual(saves(tb), [{ type: "save", id: 3, text: "Booked for Friday" }]);
    assert.equal(tb.storage.get("note:msg3@example.com"), "Booked for Friday");
    assert.deepEqual(tagsOf(tb, msgs[2].id), ["mailnote"]);
    assert.equal(page.closed, true);
    assertClean(tb);
  });

  it("Done with nothing changed closes without sending a save", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "keep" } });
    const { page, $ } = await editor(tb);
    $("done").click();
    await flush();
    assert.equal(page.closed, true);
    assert.deepEqual(saves(tb), []);
    assert.equal(tb.storage.get("note:msg1@example.com"), "keep");
    assertClean(tb);
  });

  it("Ctrl+Enter and Cmd+Enter save, then close; plain Enter does not", async (t) => {
    const { tb } = await boot(t);
    let ed = await editor(tb);
    ed.$("text").value = "one";
    ed.key({ key: "Enter" });
    await flush();
    assert.deepEqual(saves(tb), []);
    assert.equal(ed.page.closed, false);
    ed.key({ key: "Enter", ctrlKey: true });
    assert.equal(saves(tb).length, 1, "the save is sent first");
    assert.equal(ed.page.closeRequested, false, "close only after the save has answered");
    await flush();
    assert.equal(tb.storage.get("note:msg1@example.com"), "one");
    assert.equal(ed.page.closed, true);

    ed = await editor(tb);
    ed.$("text").value = "two";
    ed.key({ key: "Enter", metaKey: true });
    await flush();
    assert.equal(tb.storage.get("note:msg1@example.com"), "two");
    assert.equal(ed.page.closed, true);
    assertClean(tb);
  });

  it("Escape saves the typed text, then closes", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "keep" } });
    const ed = await editor(tb);
    ed.$("text").value = "changed";
    ed.key({ key: "Escape" });
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "changed" }], "the save is sent first");
    assert.equal(ed.page.closeRequested, false, "close only after the save has answered");
    await flush();
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "changed" }]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "changed");
    assert.equal(ed.page.closed, true);
    assertClean(tb);
  });

  it("Delete removes the note and the tag, then closes", async (t) => {
    const { tb, msgs } = await boot(t, {
      messages: [{ subject: "Invoice 42", tags: ["$label4", "mailnote"] }],
      storage: { "note:msg1@example.com": "old" },
    });
    const { page, $ } = await editor(tb);
    $("del").click();
    await flush();
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "" }]);
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["$label4"]);
    assert.equal(page.closed, true);
    assertClean(tb);
  });

  it("autosaves 500 ms after the last keystroke, and only then", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    ed.type("W");
    await advance(tb, 499);
    assert.deepEqual(saves(tb), []);
    ed.type("Wa");
    await advance(tb, 499);
    assert.deepEqual(saves(tb), [], "each keystroke restarts the 500 ms wait");
    await advance(tb, 1);
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "Wa" }]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Wa");
    assert.equal(ed.$("del").hidden, false, "Delete appears once a note exists");
    assert.equal(ed.page.closed, false, "autosave keeps the editor open");
    assertClean(tb);
  });

  it("autosave sends nothing when the text is unchanged (ignoring surrounding whitespace)", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "keep" } });
    const ed = await editor(tb);
    ed.type("keep  ");
    await advance(tb, 500);
    assert.deepEqual(saves(tb), []);
    assertClean(tb);
  });

  it("clearing the text by typing deletes the note when the autosave fires", async (t) => {
    const { tb, msgs } = await boot(t, { messages: [{ subject: "Invoice 42", tags: ["mailnote"] }], storage: { "note:msg1@example.com": "old" } });
    const ed = await editor(tb);
    ed.type("");
    await advance(tb, 500);
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assert.deepEqual(tagsOf(tb, msgs[0].id), []);
    assert.equal(ed.$("del").hidden, true);
    assertClean(tb);
  });

  it("closing the panel by clicking elsewhere saves what was typed (pagehide), once", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[0].id]);
    const popup = tb.clickActionButton("messageDisplayAction");
    await flush();
    const text = popup.page.document.getElementById("text");
    text.value = "Typed, then clicked away";
    text.dispatchEvent(new popup.page.window.Event("input", { bubbles: true }));
    tb.dismissPopup(popup); // before the 500 ms autosave
    await flush();
    assert.equal(popup.page.closed, true);
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "Typed, then clicked away" }]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Typed, then clicked away");
    await advance(tb, 1000);
    assert.equal(saves(tb).length, 1, "the pending autosave was cancelled");
    assertClean(tb);
  });

  it("a failed save is shown in the editor, which stays open; a later Done saves and closes", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    tb.faults["storage.local.set"] = new Error("disk full");
    ed.$("text").value = "Important";
    ed.$("done").click();
    await flush();
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk full");
    assert.equal(ed.page.closed, false);
    assert.equal(tb.storage.size, 0);

    delete tb.faults["storage.local.set"];
    ed.$("done").click();
    await flush();
    assert.equal(tb.storage.get("note:msg1@example.com"), "Important");
    assert.equal(ed.$("status").textContent, "");
    assert.equal(ed.page.closed, true);
    assertClean(tb);
  });

  it("a failed autosave is shown in the editor too", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    tb.faults["storage.local.set"] = new Error("disk full");
    ed.type("x");
    await advance(tb, 500);
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk full");
    assert.equal(ed.page.closed, false);
    assertClean(tb);
  });

  it("says \"Select one message to add a note.\" and stays open when there is no message to edit", async (t) => {
    const { tb } = await boot(t);
    const { page, $ } = await editor(tb, "note.html");
    assert.equal(page.closed, false);
    assert.equal($("status").textContent, SELECT_ONE);
    assert.equal(page.document.body.classList.contains("empty"), true, "subject, text and buttons are hidden");
    page.hide(); // closing it sends nothing
    await flush();
    assert.deepEqual(saves(tb), []);
    assertClean(tb);
  });

  it("without ?id edits the message shown in the current window (toolbar/header button)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[1].id]);
    const { $ } = await editor(tb, "note.html");
    assert.equal($("subject").textContent, "Quote for racks");
    assertClean(tb);
  });

  // Until v0.4.2 the toolbar button opened note.html without an id, so these
  // ran through it. Since v0.5.0 that button opens the All notes list and no
  // button opens note.html while the reading pane is hidden, but note.js and
  // background.js keep the fallback, so the page is loaded directly.
  it("without ?id and with the reading pane hidden, edits the one message selected in the list", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[2].id]);
    const { $ } = await editor(tb, "note.html");
    assert.equal($("subject").textContent, "Lunch?");
    assert.equal($("status").textContent, "");
    assertClean(tb);
  });

  it("without ?id and with several messages selected says \"Select one message to add a note.\"", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[0].id, msgs[1].id]);
    const { page, $ } = await editor(tb, "note.html");
    assert.equal(page.closed, false);
    assert.equal($("status").textContent, SELECT_ONE);
    assertClean(tb);
  });

  it("the toolbar button opens the All notes list, not the editor, whatever is selected (v0.5.0)", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.setMessagePaneVisible(false);
    tb.selectMessages([msgs[2].id]);
    const popup = tb.clickActionButton("browserAction");
    await flush();
    assert.equal(popup.url, tb.baseUrl + "list.html");
    assert.equal(popup.page.document.getElementById("text"), null, "no editor text box");
    assert.ok(popup.page.document.getElementById("search"), "the list's search box");
    assert.deepEqual(saves(tb), []);
    assert.deepEqual(tb.apiCalls("runtime.sendMessage"), [], "the list asks the background for nothing");
    assertClean(tb);
  });

  it("ignores a non-numeric ?id and falls back to the displayed message", async (t) => {
    const { tb, msgs } = await boot(t, { messages: THREE });
    tb.selectMessages([msgs[2].id]);
    const { $ } = await editor(tb, "note.html?id=abc");
    assert.equal($("subject").textContent, "Lunch?");
    assertClean(tb);
  });

  it("Delete, then the page unloading: the note stays deleted (pagehide sends nothing back)", async (t) => {
    // v0.4.0: Delete saved "" but left the old text in the box, so the
    // pagehide save on close put the note back.
    const { tb, msgs } = await boot(t, {
      messages: [{ subject: "Invoice 42", tags: ["$label4", "mailnote"] }],
      storage: { "note:msg1@example.com": "old" },
    });
    const { page, $ } = await editor(tb);
    let atPagehide;
    page.window.addEventListener("pagehide", () => (atPagehide = $("text").value), { capture: true });
    $("del").click();
    assert.equal($("text").value, "", "the box is cleared at once");
    await flush();
    assert.equal(page.closed, true);
    assert.equal(atPagehide, "", "the box was empty when pagehide fired");
    await advance(tb, 1000);
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "" }], "exactly one save, the delete");
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assert.deepEqual(tagsOf(tb, msgs[0].id), ["$label4"]);
    assertClean(tb);
  });

  it("Delete with an autosave still pending: one save, the delete", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "old" } });
    const ed = await editor(tb);
    ed.type("old, edited");
    await advance(tb, 200);
    ed.$("del").click();
    await flush();
    await advance(tb, 1000);
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "" }]);
    assert.equal(tb.storage.size, 0);
    assert.equal(ed.page.closed, true);
    assertClean(tb);
  });

  it("Done shortly after typing sends one save (not one more from the timer or pagehide)", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    ed.type("Call Bob");
    await advance(tb, 100);
    ed.$("done").click();
    await flush();
    assert.equal(ed.page.closed, true);
    await advance(tb, 1000);
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "Call Bob" }]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Call Bob");
    assertClean(tb);
  });

  it("Done or closing while an autosave is still being answered sends no second save", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    const busy = tb.hold("storage.local.set");
    ed.type("Call Bob");
    await advance(tb, 500); // the autosave is sent; its answer is held
    assert.equal(saves(tb).length, 1);
    ed.$("done").click();
    await flush();
    assert.equal(saves(tb).length, 1, "Done did not send the same text again");
    assert.equal(ed.page.closeRequested, false, "Done waits for the autosave's answer before closing");
    busy.release();
    await flush();
    await advance(tb, 1000);
    assert.equal(ed.page.closed, true);
    assert.deepEqual(saves(tb), [{ type: "save", id: 1, text: "Call Bob" }], "pagehide did not either");
    assert.equal(tb.storage.get("note:msg1@example.com"), "Call Bob");
    assertClean(tb);
  });

  it("Done while an autosave is still being answered closes only after that answer, so a failure is shown", async (t) => {
    // The contract the other Done tests check ("close only after the save has
    // answered") for the case where the autosave already carries the text.
    // v0.4.1 marked the text as saved when the autosave was sent, so Done found
    // nothing to send and closed at once; if that autosave then failed, the
    // editor was gone and the note lost without a word (this test failed on
    // v0.4.1). v0.4.2 hands Done the in-flight save's own answer.
    const { tb } = await boot(t);
    const ed = await editor(tb);
    const busy = tb.hold("storage.local.set");
    tb.faults["storage.local.set"] = new Error("disk full");
    ed.type("Call Bob");
    await advance(tb, 500);
    ed.$("done").click();
    await flush();
    assert.equal(ed.page.closeRequested, false, "Done waits for the autosave's answer");
    busy.release();
    await flush();
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk full");
    assert.equal(ed.page.closed, false, "the editor stays open to show the failure");
    assert.equal(tb.storage.size, 0);
    assert.equal(saves(tb).length, 1, "Done sent nothing of its own while the autosave was in flight");
    // Once the disk has room, Done again retries the failed text and closes.
    delete tb.faults["storage.local.set"];
    ed.$("done").click();
    await flush();
    assert.deepEqual(saves(tb).map((m) => m.text), ["Call Bob", "Call Bob"]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Call Bob");
    assert.equal(ed.$("status").textContent, "");
    assert.equal(ed.page.closed, true);
    assertClean(tb);
  });

  it("a failed save leaves the text to be saved again: closing retries it", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    tb.faults["storage.local.set"] = new Error("disk full");
    ed.type("Important");
    await advance(tb, 500);
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk full");
    delete tb.faults["storage.local.set"];
    ed.page.hide(); // closed by clicking elsewhere
    await flush();
    assert.deepEqual(saves(tb).map((m) => m.text), ["Important", "Important"], "the pagehide save is sent again");
    assert.equal(tb.storage.get("note:msg1@example.com"), "Important");
    assertClean(tb);
  });

  it("a load that fails shows why, keeps the text box disabled, and closing saves nothing", async (t) => {
    // e.g. the right-clicked message was deleted before the panel loaded.
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "keep" } });
    const { page, $ } = await editor(tb, "note.html?id=99");
    assert.equal($("status").textContent, "Couldn't open the note: Message not found: 99.");
    assert.equal($("text").disabled, true);
    assert.equal($("subject").textContent, "");
    assert.equal(page.document.body.classList.contains("empty"), false);
    assert.deepEqual(page.focusLog, [], "nothing to focus");
    $("done").click();
    await flush();
    assert.equal(page.closed, true);
    assert.deepEqual(saves(tb), [], "no save from Done or pagehide");
    assert.equal(tb.storage.get("note:msg1@example.com"), "keep");
    assertClean(tb);
  });

  it("a load that fails for a message with a note never deletes that note on close", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "keep" } });
    tb.faults["messages.get"] = new Error("folder busy");
    const { page, $ } = await editor(tb, "note.html?id=1");
    assert.equal($("status").textContent, "Couldn't open the note: folder busy");
    delete tb.faults["messages.get"];
    page.hide(); // closed by clicking elsewhere
    await flush();
    assert.deepEqual(saves(tb), []);
    assert.equal(tb.storage.get("note:msg1@example.com"), "keep");
    assertClean(tb);
  });

  it("the text box is disabled and unfocused until the note has loaded, so no typing can be overwritten", async (t) => {
    // A real keystroke cannot reach a disabled textarea; jsdom does not turn
    // key events into text, so the guard itself is what is checked here.
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "Existing note" } });
    const slow = tb.hold("messages.get");
    const page = tb.loadExtensionPage("note.html?id=1", { name: "editor" });
    await flush();
    const text = page.document.getElementById("text");
    assert.equal(text.disabled, true, "disabled while loading");
    assert.equal(text.hasAttribute("disabled"), true, "disabled in note.html itself, before note.js runs");
    text.focus(); // a click or Tab into the box
    assert.notEqual(page.document.activeElement, text, "a disabled box cannot take focus");
    assert.equal(text.value, "");
    slow.release();
    await flush();
    assert.equal(text.disabled, false);
    assert.equal(text.value, "Existing note");
    assert.equal(page.document.activeElement, text);
    assert.deepEqual(saves(tb), []);
    assertClean(tb);
  });

  it("Done before the note has loaded closes without saving anything", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "Existing note" } });
    const slow = tb.hold("messages.get");
    const page = tb.loadExtensionPage("note.html?id=1", { name: "editor" });
    await flush();
    page.document.getElementById("done").click();
    await flush();
    assert.equal(page.closed, true);
    slow.release();
    await flush();
    assert.deepEqual(saves(tb), []);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Existing note");
    assertClean(tb);
  });

  it("a load with no message leaves the text box disabled and hidden", async (t) => {
    const { tb } = await boot(t);
    const { page, $ } = await editor(tb, "note.html");
    assert.equal($("text").disabled, true);
    assert.equal(page.document.body.classList.contains("empty"), true);
    assert.deepEqual(page.focusLog, []);
    assertClean(tb);
  });

  it("shows subject and note as text, never as markup", async (t) => {
    const evil = '<img src=x onerror="alert(1)">';
    const { tb } = await boot(t, { messages: [{ subject: evil }], storage: { "note:msg1@example.com": evil } });
    const { page, $ } = await editor(tb);
    assert.equal($("subject").textContent, evil);
    assert.equal($("text").value, evil);
    assert.equal(page.document.querySelector("img"), null);
    assertClean(tb);
  });
});

describe("saves are sent once and retried after a failure; Delete only for a loaded note (v0.4.2)", { skip }, () => {
  // note.js keeps the text of the latest save sent (lastSent) and that save's
  // promise (inFlight). A save of the same trimmed text returns inFlight
  // instead of sending again; a failed save forgets lastSent unless a newer
  // save has been sent since, so the next save of that text is sent again.
  const texts = (tb) => saves(tb).map((m) => m.text);

  it("a failed autosave is retried by the next autosave of the same text", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    tb.faults["storage.local.set"] = new Error("disk full");
    ed.type("Important");
    await advance(tb, 500);
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk full");
    assert.equal(ed.$("del").hidden, true, "a failed save does not offer Delete");
    delete tb.faults["storage.local.set"];
    ed.type("Important "); // a keystroke that leaves the trimmed text as it was
    await advance(tb, 500);
    assert.deepEqual(texts(tb), ["Important", "Important "]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Important");
    assert.equal(ed.$("status").textContent, "");
    assert.equal(ed.$("del").hidden, false);
    assert.equal(ed.page.closed, false);
    assertClean(tb);
  });

  it("Done after a failed autosave of the same text retries it, then closes", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    tb.faults["storage.local.set"] = new Error("disk full");
    ed.type("Call Bob");
    await advance(tb, 500);
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk full");
    delete tb.faults["storage.local.set"];
    ed.$("done").click();
    assert.deepEqual(texts(tb), ["Call Bob", "Call Bob"], "Done sends the text again at once");
    assert.equal(ed.page.closeRequested, false);
    await flush();
    assert.equal(tb.storage.get("note:msg1@example.com"), "Call Bob");
    assert.equal(ed.page.closed, true);
    await advance(tb, 1000);
    assert.equal(saves(tb).length, 2, "nothing more from pagehide or the timer");
    assertClean(tb);
  });

  it("an older save failing after a newer one was sent does not make Done send the newer text again", async (t) => {
    // "Call Bob" (written with storage.local.set, which fails) is overtaken in
    // the editor by "" (storage.local.remove, which works) before either is
    // answered; the background runs them in order.
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "old" } });
    const ed = await editor(tb);
    const busy = tb.hold("messages.get");
    ed.type("Call Bob");
    await advance(tb, 500);
    ed.type("");
    await advance(tb, 500);
    assert.deepEqual(texts(tb), ["Call Bob", ""], "both sent, neither answered");
    tb.faults["storage.local.set"] = new Error("disk full");
    busy.release();
    await flush();
    assert.equal(tb.storage.has("note:msg1@example.com"), false, "the newer save (delete) landed");
    assert.equal(ed.$("status").textContent, "", "the newer save's success is what the editor shows");
    ed.$("done").click();
    await flush();
    assert.deepEqual(texts(tb), ["Call Bob", ""], "Done sent nothing: the newer text is stored");
    assert.equal(ed.page.closed, true);
    assertClean(tb);
  });

  it("a newer save failing after an older one worked is retried by Done", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "old" } });
    const ed = await editor(tb);
    const busy = tb.hold("messages.get");
    ed.type("");
    await advance(tb, 500);
    ed.type("Call Bob");
    await advance(tb, 500);
    tb.faults["storage.local.set"] = new Error("disk full");
    busy.release();
    await flush();
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk full");
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    delete tb.faults["storage.local.set"];
    ed.$("done").click();
    await flush();
    assert.deepEqual(texts(tb), ["", "Call Bob", "Call Bob"]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Call Bob");
    assert.equal(ed.page.closed, true);
    assertClean(tb);
  });

  it("Done, Ctrl+Enter and Escape pressed while the save is in flight send one save and close once", async (t) => {
    const { tb } = await boot(t);
    const ed = await editor(tb);
    const busy = tb.hold("storage.local.set");
    ed.$("text").value = "Call Bob";
    ed.$("done").click();
    ed.$("done").click();
    ed.key({ key: "Enter", ctrlKey: true });
    ed.key({ key: "Escape" });
    await flush();
    assert.deepEqual(texts(tb), ["Call Bob"]);
    assert.equal(ed.page.closeRequested, false, "still waiting for the answer");
    busy.release();
    await flush();
    assert.equal(ed.page.closed, true);
    await advance(tb, 1000);
    assert.deepEqual(texts(tb), ["Call Bob"]);
    assert.equal(tb.storage.get("note:msg1@example.com"), "Call Bob");
    assertClean(tb);
  });

  it("a Delete that fails keeps the editor open; closing it then retries the delete, never restoring the note", async (t) => {
    const { tb, msgs } = await boot(t, {
      messages: [{ subject: "Invoice 42", tags: ["mailnote"] }],
      storage: { "note:msg1@example.com": "old" },
    });
    const ed = await editor(tb);
    tb.faults["storage.local.remove"] = new Error("disk busy");
    ed.$("del").click();
    await flush();
    assert.equal(ed.$("status").textContent, "Couldn't save the note: disk busy");
    assert.equal(ed.page.closed, false);
    assert.equal(ed.$("text").value, "", "the box stays empty");
    assert.equal(tb.storage.get("note:msg1@example.com"), "old");
    delete tb.faults["storage.local.remove"];
    ed.page.hide(); // closed by clicking elsewhere
    await flush();
    assert.deepEqual(texts(tb), ["", ""], "pagehide sends the delete again");
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assert.deepEqual(tagsOf(tb, msgs[0].id), []);
    assertClean(tb);
  });

  it("Delete while an autosave of edited text is in flight: the delete goes after it and the note ends deleted", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "old" } });
    const ed = await editor(tb);
    const busy = tb.hold("storage.local.set");
    ed.type("old, edited");
    await advance(tb, 500);
    ed.$("del").click();
    await flush();
    assert.deepEqual(texts(tb), ["old, edited", ""]);
    assert.equal(ed.page.closeRequested, false, "Delete waits for its own answer");
    busy.release();
    await flush();
    await advance(tb, 1000);
    assert.equal(ed.page.closed, true);
    assert.deepEqual(texts(tb), ["old, edited", ""], "pagehide sent nothing back");
    assert.equal(tb.storage.has("note:msg1@example.com"), false);
    assertClean(tb);
  });

  it("Delete note is hidden in note.html itself and while the note loads, then shown for a note", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "Existing note" } });
    const slow = tb.hold("messages.get");
    const page = tb.loadExtensionPage("note.html?id=1", { name: "editor" });
    await flush();
    const del = page.document.getElementById("del");
    assert.equal(del.hasAttribute("hidden"), true, "hidden in note.html, before note.js runs");
    assert.equal(del.hidden, true, "still hidden while loading");
    slow.release();
    await flush();
    assert.equal(del.hidden, false);
    assertClean(tb);
  });

  it("Delete note stays hidden after a failed load, even for a message that has a note", async (t) => {
    const { tb } = await boot(t, { storage: { "note:msg1@example.com": "keep" } });
    tb.faults["messages.get"] = new Error("folder busy");
    const ed = await editor(tb, "note.html?id=1");
    assert.equal(ed.$("status").textContent, "Couldn't open the note: folder busy");
    assert.equal(ed.$("del").hidden, true);
    const gone = await editor(tb, "note.html?id=99");
    assert.equal(gone.$("del").hidden, true);
    assertClean(tb);
  });

  it("Delete note stays hidden when there is no message to edit", async (t) => {
    const { tb } = await boot(t);
    const { $ } = await editor(tb, "note.html");
    assert.equal($("status").textContent, SELECT_ONE);
    assert.equal($("del").hidden, true);
    assertClean(tb);
  });
});

describe("\"← All notes\" link (v0.6.0)", { skip }, () => {
  it("is shown only when the note was opened from the list (from=list)", async (t) => {
    const { tb } = await boot(t, { messages: THREE });
    tb.selectMessages([2]);
    for (const [url, hidden] of [
      ["note.html?id=2&from=list", false],
      ["note.html?from=list&id=2", false],
      ["note.html?id=2", true], // a right-click's panel
      ["note.html", true], // the header button's own page
      ["note.html?id=2&from=menu", true],
      ["note.html?id=2&from=LIST", true],
    ]) {
      const { $ } = await editor(tb, url);
      assert.equal($("back").hidden, hidden, url);
      assert.equal($("subject").textContent, "Quote for racks", `${url} still edits its message`);
    }
    assertClean(tb);
  });

  it("is hidden in note.html itself, and links to list.html", async (t) => {
    const { tb } = await boot(t, { messages: THREE });
    const page = tb.loadExtensionPage("note.html?id=1&from=list", { name: "editor" });
    const back = page.document.getElementById("back");
    assert.equal(back.localName, "a");
    assert.equal(back.getAttribute("href"), "list.html");
    assert.equal(back.textContent, "← All notes");
    assert.equal(back.hidden, false, "shown by note.js straight away, before the note loads");
    const plain = tb.loadExtensionPage("note.html", { name: "editor" });
    assert.equal(plain.document.getElementById("back").hidden, true);
    // note.html itself, before any script runs (no flash of the link).
    const { JSDOM } = require("jsdom");
    const raw = new JSDOM(readSource("note.html")).window.document.getElementById("back");
    assert.equal(raw.hasAttribute("hidden"), true);
    await flush();
    assertClean(tb);
  });

  it("stays available when the note cannot be loaded, so there is a way back", async (t) => {
    const { tb } = await boot(t);
    const { $ } = await editor(tb, "note.html?id=99&from=list");
    assert.equal($("status").textContent, "Couldn't open the note: Message not found: 99.");
    assert.equal($("back").hidden, false);
    assertClean(tb);
  });
});
