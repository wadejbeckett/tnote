// All notes, newest message first. Clicking one selects its message in the
// current mail tab (switching folder if needed), or opens it in a tab.
const list = document.getElementById("list");
const search = document.getElementById("search");
const status = document.getElementById("status");
let notes = [];

async function findMessage(mid) {
  if (!mid) return null;
  const page = await browser.messages.query({ headerMessageId: mid }).catch(() => null);
  return page?.messages?.[0] || null;
}

async function show(n) {
  if (!n.mid) {
    status.textContent = "That message has no Message-ID, so it can't be found from here.";
    return;
  }
  const msg = await findMessage(n.mid);
  if (!msg) {
    // Thunderbird only searches folders it has indexed, so a folder not opened
    // lately can hide a message that still exists.
    status.textContent = "Couldn't find that message. It may have been deleted, or be in a folder Thunderbird hasn't opened lately; open that folder and try again.";
    return;
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true, mailTab: true });
  try {
    if (!tab) throw new Error("no mail tab");
    await browser.mailTabs.setSelectedMessages(tab.id, [msg.id]);
  } catch {
    await browser.messageDisplay.open({ messageId: msg.id, location: "tab" });
  }
  window.close();
}

function render() {
  const q = search.value.trim().toLowerCase();
  list.replaceChildren();
  for (const n of notes) {
    if (q && ![n.text, n.subject, n.author].some((s) => s?.toLowerCase().includes(q))) continue;
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `<div class="top"><span class="subject"></span><span class="date"></span></div><div class="from"></div><div class="note"></div>`;
    li.querySelector(".subject").textContent = n.subject || "(no subject)";
    li.querySelector(".date").textContent = n.date ? new Date(n.date).toLocaleDateString() : "";
    li.querySelector(".from").textContent = n.author || "";
    li.querySelector(".note").textContent = n.text;
    li.onclick = () => show(n);
    li.onkeydown = (e) => e.key === "Enter" && show(n);
    list.append(li);
  }
  status.textContent = notes.length ? (list.children.length ? "" : "No notes match.") : "No notes yet. Right-click a message and choose Add note…";
}

(async () => {
  const all = await browser.storage.local.get(null);
  for (const [key, text] of Object.entries(all)) {
    if (!key.startsWith("note:")) continue;
    const id = key.slice(5);
    let info = all["info:" + id];
    if (!info && !id.startsWith("id:")) {
      // Notes saved before the list existed: look the message up once and remember it.
      const m = await findMessage(id);
      if (m) {
        info = { subject: m.subject, author: m.author, date: new Date(m.date).getTime(), mid: id };
        browser.storage.local.set({ ["info:" + id]: info }).catch(() => {});
      }
    }
    notes.push({ text, mid: id.startsWith("id:") ? null : id, ...info });
  }
  notes.sort((a, b) => (b.date || 0) - (a.date || 0));
  render();
  search.focus();
})();
search.addEventListener("input", render);
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && list.firstElementChild) list.firstElementChild.click();
});
