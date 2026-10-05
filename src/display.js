// Shows the note as a slim bar at the top of the open message. The shadow root
// keeps the email's CSS off the bar's contents (not off the host element itself).
(async () => {
  const note = await browser.runtime.sendMessage({ type: "forDisplay" }).catch(() => null);
  if (!note) return;
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    div { font: menu; font-size: 13px; white-space: pre-wrap; margin: 0 0 12px;
      padding: 8px 12px; border-left: 3px solid #2E8B57; border-radius: 4px;
      background: color-mix(in srgb, #2E8B57 12%, Canvas); color: CanvasText; }
    b { font-weight: 600; }
    @media print { div { display: none; } }
  </style><div><b>Note: </b><span></span></div>`;
  const span = root.querySelector("span");
  const render = (text) => {
    span.textContent = text;
    if (text && !host.isConnected) document.body.prepend(host);
    if (!text) host.remove();
  };
  render(note.text);
  browser.storage.onChanged.addListener((changes) => {
    if (note.key in changes) render(changes[note.key].newValue || "");
  });
})();
