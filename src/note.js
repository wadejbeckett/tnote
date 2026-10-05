// The note saves itself as you type, so closing the panel by clicking elsewhere
// never loses it.
const params = new URLSearchParams(location.search);
let id = Number(params.get("id")) || null;
// Opened from the All notes list: offer the way back.
document.getElementById("back").hidden = params.get("from") !== "list";
const text = document.getElementById("text");
const status = document.getElementById("status");
const del = document.getElementById("del");
let timer = null;
let lastSent = ""; // text of the latest save sent (or of the loaded note)
let inFlight = Promise.resolve(true);

(async () => {
  let note;
  try {
    note = await browser.runtime.sendMessage({ type: "load", id });
  } catch (e) {
    status.textContent = "Couldn't open the note: " + (e?.message || e);
    return;
  }
  if (!note) {
    document.body.classList.add("empty");
    status.textContent = "Select one message to add a note.";
    return;
  }
  id = note.id;
  document.getElementById("subject").textContent = note.subject;
  text.value = lastSent = note.text;
  text.disabled = false;
  del.hidden = !note.text;
  text.focus();
})();

// Returns whether the text is stored. Saves of the same text are sent once; a
// repeat waits on the one already in flight.
function save(value) {
  clearTimeout(timer);
  if (!id || value.trim() === lastSent?.trim()) return inFlight;
  lastSent = value;
  inFlight = browser.runtime.sendMessage({ type: "save", id, text: value }).then(
    () => {
      status.textContent = "";
      del.hidden = !value.trim();
      return true;
    },
    (e) => {
      if (lastSent === value) lastSent = null; // let the next save retry it
      status.textContent = "Couldn't save the note: " + (e?.message || e);
      return false;
    },
  );
  return inFlight;
}

async function done(value = text.value) {
  // Keep the box in step, or the save on pagehide would put a deleted note back.
  text.value = value;
  if (await save(value)) window.close();
}

text.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => save(text.value), 500);
});
window.addEventListener("pagehide", () => save(text.value));
document.getElementById("done").onclick = () => done();
del.onclick = () => done("");
text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done();
  if (e.key === "Escape") done();
});
