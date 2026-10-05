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
const POPUP = "note.html"; // header Note button: this message's note
const LIST = "list.html"; // toolbar tNOTE button: all notes

// Thunderbird reads the popup URL when the panel opens, so pointing it at this
// message just for the call hands the panel its id with no shared state.
// setPopup is deliberately not awaited: its promise waits for a repaint in every
// window, which never comes in a hidden message pane, but the new URL itself is
// applied as soon as the call arrives, ahead of the openPopup call behind it.
const warn = (e) => console.warn("tNOTE:", e);

async function openPanel(action, url, opts, reset) {
  action.setPopup({ popup: url }).catch(warn);
  try {
    return await action.openPopup(opts);
  } catch {
    return false;
  } finally {
    action.setPopup({ popup: reset }).catch(warn);
  }
}

// getDisplayedMessage waits for the reading pane to finish loading; don't let a
// slow or failed load hold up the editor.
const displayedMessage = (tabId, ms = 1000) =>
  Promise.race([
    messenger.messageDisplay.getDisplayedMessage(tabId).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

messenger.menus.onClicked.addListener(async (info, tab) => {
  const msgs = info.selectedMessages?.messages || [];
  if (msgs.length !== 1) return;
  const msg = msgs[0];
  const url = POPUP + "?id=" + msg.id;
  const opts = { windowId: tab?.windowId };
  // The header panel hangs off the displayed message. If another message is on
  // display, select the right-clicked one first, as clicking it would, so the note
  // opens under it. The toolbar panel is only for when nothing can be displayed
  // (reading pane hidden).
  let shown = tab ? await displayedMessage(tab.id) : null;
  if (tab?.mailTab && shown?.id !== msg.id) {
    await messenger.mailTabs.setSelectedMessages(tab.id, [msg.id]).catch(warn);
    shown = await displayedMessage(tab.id, 2000);
  }
  const opened =
    (shown?.id === msg.id && (await openPanel(messenger.messageDisplayAction, url, opts, POPUP))) ||
    (await openPanel(messenger.browserAction, url, opts, LIST));
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

// What the All notes list shows, plus the folder, so finding the message later
// searches one folder. Searching every folder (no folderId) reads every message
// header in every account, which takes far too long on large mailboxes.
const infoFor = (m) => ({
  subject: m.subject,
  author: m.author,
  date: m.date?.getTime?.() ?? m.date,
  mid: m.headerMessageId,
  folderId: m.folder?.id,
});

async function query(q) {
  const page = await messenger.messages.query({ ...q, messagesPerPage: 1 }).catch(() => null);
  return page?.messages?.[0] || null;
}

// Finds a noted message by Message-ID: in its last known folder first, then
// everywhere (slow). Remembers where it was found.
async function findMessage(mid, { remember = true, info } = {}) {
  if (!mid) return null;
  const infoKey = "info:" + mid;
  info ??= (await messenger.storage.local.get(infoKey))[infoKey];
  let m = info?.folderId ? await query({ folderId: info.folderId, headerMessageId: mid }) : null;
  m ||= await query({ headerMessageId: mid });
  if (m && remember && (!info || info.missing || info.folderId !== m.folder?.id)) {
    await messenger.storage.local.set({ [infoKey]: infoFor(m) });
  }
  return m;
}

async function untag(m) {
  if (m.external || !m.tags.includes(TAG)) return;
  await messenger.messages.update(m.id, { tags: m.tags.filter((t) => t !== TAG) });
}

messenger.runtime.onMessage.addListener(async (req, sender) => {
  if (req.type === "forDisplay") {
    if (!sender.tab) return null;
    const m = await messenger.messageDisplay.getDisplayedMessage(sender.tab.id);
    if (!m) return null;
    const key = keyFor(m);
    const text = (await messenger.storage.local.get(key))[key] || "";
    // Keep the list's record current (folder moves, notes saved before 0.6).
    if (text && m.headerMessageId && !m.external) {
      const infoKey = "info:" + m.headerMessageId;
      const info = (await messenger.storage.local.get(infoKey))[infoKey];
      if (info?.folderId !== m.folder?.id) messenger.storage.local.set({ [infoKey]: infoFor(m) }).catch(warn);
    }
    return { key, text };
  }
  if (req.type === "describe") {
    // A list row without details: look the message up once. If it can't be found,
    // say so on record, so the list doesn't search every folder on every opening.
    if (!req.mid) return null;
    const m = await findMessage(req.mid, { remember: false });
    const info = m ? infoFor(m) : { mid: req.mid, missing: true };
    // Only keep the record while the note exists; it may have been deleted
    // during a slow search.
    const noteKey = "note:" + req.mid;
    const infoKey = "info:" + req.mid;
    const stored = await messenger.storage.local.get([noteKey, infoKey]);
    const old = stored[infoKey];
    const changed = !old || !!old.missing !== !!info.missing || old.folderId !== info.folderId;
    if (stored[noteKey] && changed) await messenger.storage.local.set({ [infoKey]: info });
    return info;
  }
  if (req.type === "reveal") {
    // Select the note's message in the window's mail tab, switching folder.
    const m = await findMessage(req.mid);
    if (!m) return null;
    const [tab] = await messenger.tabs.query({ active: true, windowId: req.windowId, mailTab: true });
    if (tab) await messenger.mailTabs.setSelectedMessages(tab.id, [m.id]).catch(warn);
    return { id: m.id };
  }
  if (req.type === "remove") {
    // Queued with saves, so a save still finishing can't bring the note back.
    const result = saving.then(() => remove(req.key));
    saving = result.catch(() => {});
    return result;
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
  // "info:" keeps what the All notes list shows, so it needn't search for messages.
  const info = "info:" + key.slice(5);
  if (text) {
    await messenger.storage.local.set({ [key]: text, [info]: infoFor(m) });
  } else {
    await messenger.storage.local.remove([key, info]);
  }
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

// Delete from the list, by storage key suffix (a Message-ID, or "id:N" for a
// message without one): note and record first, then the tag once the message is
// found via the folder on record.
async function remove(key) {
  const infoKey = "info:" + key;
  const info = (await messenger.storage.local.get(infoKey))[infoKey] || {};
  await messenger.storage.local.remove(["note:" + key, infoKey]);
  if (key.startsWith("id:")) return true;
  const m = await findMessage(key, { remember: false, info }).catch(() => null);
  if (m) await untag(m).catch(warn);
  return true;
}

messenger.messageDisplayScripts.register({ js: [{ file: "display.js" }] });
