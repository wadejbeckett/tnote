// Notes live in storage.local under "note:<Message-ID>", so they follow the
// message across folders. A green "Note" tag marks noted messages in the list.
const TAG = "mailnote";
const GREEN = "#2E8B57";
const keyFor = (m) => "note:" + (m.headerMessageId || "id:" + m.id);

async function ensureTag() {
  const tags = await messenger.messages.tags.list();
  const tag = tags.find((t) => t.key === TAG);
  if (!tag) {
    // tags.create refuses a name already in use, such as the user's own "Note" tag.
    const name = tags.some((t) => t.tag === "Note") ? "tNOTE" : "Note";
    await messenger.messages.tags.create(TAG, name, GREEN);
  } else if (tag.color.toUpperCase() !== GREEN) {
    await messenger.messages.tags.update(TAG, { color: GREEN });
  }
}
ensureTag().catch((e) => console.warn("tNOTE: could not set up the Note tag", e));

messenger.menus.create({ id: "mail-note", title: "Add note…", contexts: ["message_list"] });

messenger.menus.onShown.addListener(async (info) => {
  if (!info.menuIds.includes("mail-note")) return;
  const msgs = info.selectedMessages?.messages || [];
  // A collapsed thread counts as all of its messages, so it lands here too.
  let title = "Add note (select one message)";
  if (msgs.length === 1) {
    const key = keyFor(msgs[0]);
    title = (await messenger.storage.local.get(key))[key] ? "Edit note…" : "Add note…";
  }
  await messenger.menus.update("mail-note", { title, enabled: msgs.length === 1 });
  messenger.menus.refresh();
});

// The editor opens as a drop-down panel, which belongs to the main window and so
// always appears in front. A separate popup window would open behind Thunderbird
// on desktops with focus-stealing prevention (Cinnamon), so the last resort is a
// tab in the same window instead.
const POPUP = "note.html";

// Thunderbird reads the popup URL when the panel opens, so pointing it at this
// message just for the call hands the panel its id with no shared state.
// setPopup is deliberately not awaited: its promise waits for a repaint in every
// window, which never comes in a hidden message pane, but the new URL itself is
// applied as soon as the call arrives, ahead of the openPopup call behind it.
const warn = (e) => console.warn("tNOTE:", e);

async function openPanel(action, url, opts) {
  action.setPopup({ popup: url }).catch(warn);
  try {
    return await action.openPopup(opts);
  } catch {
    return false;
  } finally {
    action.setPopup({ popup: POPUP }).catch(warn);
  }
}

// getDisplayedMessage waits for the reading pane to finish loading; don't let a
// slow or failed load hold up the editor.
const displayedMessage = (tabId) =>
  Promise.race([
    messenger.messageDisplay.getDisplayedMessage(tabId).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);

messenger.menus.onClicked.addListener(async (info, tab) => {
  const msgs = info.selectedMessages?.messages || [];
  if (msgs.length !== 1) return;
  const msg = msgs[0];
  const url = POPUP + "?id=" + msg.id;
  const opts = { windowId: tab?.windowId };
  // The header panel hangs off the displayed message, so use it only when that is
  // the message that was right-clicked; otherwise use the main toolbar button.
  const shown = tab ? await displayedMessage(tab.id) : null;
  const opened =
    (shown?.id === msg.id && (await openPanel(messenger.messageDisplayAction, url, opts))) ||
    (await openPanel(messenger.browserAction, url, opts));
  if (!opened) messenger.tabs.create({ url, windowId: tab?.windowId });
});

async function currentMessageId() {
  const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  const shown = await displayedMessage(tab.id);
  if (shown) return shown.id;
  // Reading pane hidden: fall back to the selection in the message list.
  const sel = await messenger.mailTabs.getSelectedMessages(tab.id).catch(() => null);
  return sel?.messages?.length === 1 ? sel.messages[0].id : null;
}

let saving = Promise.resolve();

messenger.runtime.onMessage.addListener(async (req, sender) => {
  if (req.type === "forDisplay") {
    if (!sender.tab) return null;
    const m = await messenger.messageDisplay.getDisplayedMessage(sender.tab.id);
    if (!m) return null;
    const key = keyFor(m);
    return { key, text: (await messenger.storage.local.get(key))[key] || "" };
  }
  if (req.type === "load") {
    const id = req.id || (await currentMessageId());
    if (!id) return null;
    const m = await messenger.messages.get(id);
    const key = keyFor(m);
    return { id: m.id, subject: m.subject, text: (await messenger.storage.local.get(key))[key] || "" };
  }
  if (req.type === "save") {
    // One save at a time, so a quick add-then-clear can't finish out of order and
    // leave the tag out of step with the note.
    const result = saving.then(() => save(req));
    saving = result.catch(() => {});
    return result;
  }
});


async function save(req) {
  const m = await messenger.messages.get(req.id);
  const key = keyFor(m);
  const text = req.text.trim();
  if (text) await messenger.storage.local.set({ [key]: text });
  else await messenger.storage.local.remove(key);
  // The note is safe once stored; tagging is best effort. Messages opened from a
  // file have no folder and can't be tagged at all.
  if (!m.external) {
    try {
      const tags = new Set(m.tags);
      if (text) {
        await ensureTag();
        tags.add(TAG);
      } else {
        tags.delete(TAG);
      }
      await messenger.messages.update(m.id, { tags: [...tags] });
    } catch (e) {
      console.warn("tNOTE: note saved but the message could not be tagged", e);
    }
  }
  return true;
}

messenger.messageDisplayScripts.register({ js: [{ file: "display.js" }] });
