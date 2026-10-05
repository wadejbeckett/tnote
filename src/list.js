// All notes, newest message first. Clicking one selects its message in this
// window's mail tab and opens the note in this panel; ✕ deletes a note.
const list = document.getElementById("list");
const search = document.getElementById("search");
const status = document.getElementById("status");
let notes = [];
let windowId = null;

async function open(n) {
  if (!n.mid) {
    status.textContent = "That message has no Message-ID, so it can't be found from here.";
    return;
  }
  status.textContent = n.folderId ? "Opening…" : "Searching all folders for this message (once)…";
  const found = await browser.runtime.sendMessage({ type: "reveal", mid: n.mid, windowId }).catch(() => null);
  if (!found) {
    // Thunderbird only searches folders it has indexed, so a folder not opened
    // lately can hide a message that still exists.
    status.textContent = "Couldn't find that message. It may have been deleted, or be in a folder Thunderbird hasn't opened lately; open that folder and try again.";
    return;
  }
  location.href = "note.html?id=" + found.id + "&from=list";
}

async function remove(n, li) {
  li.remove();
  notes = notes.filter((x) => x !== n);
  render();
  await browser.runtime.sendMessage({ type: "remove", key: n.key }).catch((e) => {
    status.textContent = "Couldn't delete the note: " + (e?.message || e);
  });
}

function label(n) {
  if (!n.mid) return "(message without a Message-ID)";
  if (n.missing) return "(message not found)";
  if (!n.described) return "Finding message…";
  return n.subject || "(no subject)";
}

function fill(li, n) {
  li.querySelector(".subject").textContent = label(n);
  li.querySelector(".date").textContent = n.date ? new Date(n.date).toLocaleDateString() : "";
  li.querySelector(".from").textContent = n.author || "";
  li.querySelector(".note").textContent = n.text;
}

function row(n) {
  const li = document.createElement("li");
  n.li = li;
  li.tabIndex = 0;
  li.innerHTML = `<div class="top"><span class="subject"></span><span class="date"></span>
    <button class="del" title="Delete note" aria-label="Delete note">✕</button></div>
    <div class="from"></div><div class="note"></div>`;
  fill(li, n);
  const del = li.querySelector(".del");
  // First click arms, second deletes; the button disarms after 3 s.
  del.onclick = (e) => {
    e.stopPropagation();
    if (del.classList.contains("armed")) return remove(n, li);
    del.classList.add("armed");
    del.textContent = "Delete";
    setTimeout(() => {
      del.classList.remove("armed");
      del.textContent = "✕";
    }, 3000);
  };
  li.onclick = () => open(n);
  li.onkeydown = (e) => e.key === "Enter" && e.target === li && open(n);
  return li;
}

function render() {
  const q = search.value.trim().toLowerCase();
  list.replaceChildren(
    ...notes
      .filter((n) => !q || [n.text, n.subject, n.author].some((s) => s?.toLowerCase().includes(q)))
      .map(row),
  );
  status.textContent = notes.length ? (list.children.length ? "" : "No notes match.") : "No notes yet. Right-click a message and choose Add note…";
}

(async () => {
  windowId = (await browser.windows.getCurrent()).id;
  const all = await browser.storage.local.get(null);
  for (const [key, text] of Object.entries(all)) {
    if (!key.startsWith("note:")) continue;
    const id = key.slice(5);
    const info = all["info:" + id];
    notes.push({ ...info, text, key: id, mid: id.startsWith("id:") ? null : id, described: !!info });
  }
  notes.sort((a, b) => (b.date || 0) - (a.date || 0));
  render();
  search.focus();
  // Notes saved before the list existed have no details yet: fill them in one at
  // a time (each search holds Thunderbird up while it runs), updating rows in
  // place so an armed Delete or a status message isn't lost.
  for (const n of notes.filter((n) => n.mid && !n.described)) {
    if (!notes.includes(n)) continue; // deleted while waiting its turn
    const info = await browser.runtime.sendMessage({ type: "describe", mid: n.mid }).catch(() => null);
    if (!info) continue;
    Object.assign(n, info, { described: true });
    if (n.li?.isConnected) fill(n.li, n);
  }
})();
search.addEventListener("input", render);
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && list.firstElementChild) list.firstElementChild.click();
});
