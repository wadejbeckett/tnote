"use strict";
// A small, schema-checked model of Thunderbird 153 for running tNOTE's real
// source files. Behaviour is copied from the installed Thunderbird's own
// implementation files (paths inside omni.ja, line numbers as of 153.3.1):
//   ext-messages.js       chrome/messenger/content/messenger/parent/ext-messages.js
//   ext-menus.js          chrome/messenger/content/messenger/parent/ext-menus.js
//   ext-messageDisplay.js chrome/messenger/content/messenger/parent/ext-messageDisplay.js
//   ext-messageDisplayAction.js, ext-browserAction.js, ext-windows.js (same dir)
//   ext-tabs.js, ext-mailTabs.js, ext-mail.js (same dir)
//   about3Pane.js, aboutMessage.js, pane-layout.mjs, message-pane.mjs,
//   specialTabs.js, tabmail.js (chrome/messenger/content/messenger/)
//   ExtensionToolbarButtons.sys.mjs, ExtensionStorageIDB.sys.mjs, ExtensionPopups.sys.mjs,
//   ExtensionChild.sys.mjs, ExtensionParent.sys.mjs, ExtensionMessages.sys.mjs,
//   ExtensionMailTabs.sys.mjs, ExtensionCommon.sys.mjs, Schemas.sys.mjs,
//   Extension.sys.mjs (modules/)
//   all-thunderbird.js (defaults/pref/)
// Anything not copied from there is marked "MODEL" and is an assumption.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadThunderbirdSchemas } = require("./omni.js");
const { SchemaRoot } = require("./schemas.js");
const { ApiBuilder, FakeError } = require("./api.js");

const SRC = process.env.TNOTE_SRC || path.resolve(__dirname, "../../src");
const UUID = "0c6f3f0e-6b1c-4a59-9d2a-7a1e5e7d0a11";
const BASE_URL = `moz-extension://${UUID}/`;
// ExtensionParent.sys.mjs:56
const ERROR_NO_RECEIVERS = "Could not establish connection. Receiving end does not exist.";

// MODEL: Thunderbird's default tag set (mailnews prefs), uppercase as tags.list
// reports colours (ext-messages.js:2079).
const DEFAULT_TAGS = [
  { key: "$label1", tag: "Important", color: "#FF0000", ordinal: "" },
  { key: "$label2", tag: "Work", color: "#FF9900", ordinal: "" },
  { key: "$label3", tag: "Personal", color: "#009900", ordinal: "" },
  { key: "$label4", tag: "To Do", color: "#3333FF", ordinal: "" },
  { key: "$label5", tag: "Later", color: "#993399", ordinal: "" },
];

const INBOX = {
  accountId: "account1",
  id: "account1://INBOX",
  name: "Inbox",
  path: "/INBOX",
  specialUse: ["inbox"],
  type: "inbox",
  isFavorite: false,
  isRoot: false,
  isTag: false,
  isUnified: false,
  isVirtual: false,
};

/** Gecko's ExtensionError reaches the extension as a plain Error with this message. */
class ExtensionError extends Error {}

// The two toolbar-button APIs tNOTE uses, with their manifest keys. Both are
// ToolbarButtonAPI subclasses (ext-browserAction.js:22, ext-messageDisplayAction.js:15).
const ACTION_KEYS = [
  ["browserAction", "browser_action"],
  ["messageDisplayAction", "message_display_action"],
];
const PANEL_KINDS = new Set(ACTION_KEYS.map(([kind]) => kind));

let schemaCache;
function thunderbirdSchemas() {
  if (!schemaCache) {
    const loaded = loadThunderbirdSchemas();
    schemaCache = loaded.ok ? { ...loaded, root: new SchemaRoot(loaded.files) } : loaded;
  }
  return schemaCache;
}

function readSource(rel, dir = SRC) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function readManifest(dir = SRC) {
  return JSON.parse(readSource("manifest.json", dir));
}

function flush(rounds = 25) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

const isPromise = (v) => v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object Promise]";

/**
 * MODEL: one virtual clock for every script the fake runs (background page,
 * extension pages, message display documents). Real time never passes for the
 * add-on during a test: Date.now() stands still and setTimeout callbacks only
 * run when a test calls advance(ms), in due order. The fake's own "after this
 * call" deliveries (setImmediate) are not affected.
 */
class FakeClock {
  constructor(start = Date.UTC(2026, 9, 5, 8, 0, 0)) {
    this.time = start;
    this.timers = new Map();
    this.nextId = 1;
  }

  now() {
    return this.time;
  }

  setTimeout(fn, ms, args, onError) {
    const id = this.nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    this.timers.set(id, { at: this.time + delay, fn, args, onError });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  /** Moves time forward, running every timer that falls due on the way. */
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of this.timers) {
        if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.time = next.t.at;
      try {
        if (typeof next.t.fn === "function") next.t.fn(...next.t.args);
      } catch (e) {
        next.t.onError?.(e);
      }
    }
    this.time = end;
  }

  /** Puts the clock into a script global (a vm context or a jsdom window). */
  install(global, intrinsics, onError) {
    intrinsics.Date.now = () => this.now();
    global.setTimeout = (fn, ms, ...args) => this.setTimeout(fn, ms, args, onError);
    global.clearTimeout = (id) => this.clearTimeout(id);
  }

  dispose() {
    this.timers.clear();
  }
}

// Unhandled rejections inside the add-on (for example an un-awaited call that
// fails) are recorded on the running world, the way Thunderbird would only log
// them to the console. While a world is alive it is the only listener, so the
// test runner does not blame whichever test happens to be running; tests check
// world.unhandled explicitly (assertClean does).
function captureRejections(world) {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const handler = (reason) => world.unhandled.push(reason);
  process.on("unhandledRejection", handler);
  return () => {
    process.removeListener("unhandledRejection", handler);
    for (const l of saved) process.on("unhandledRejection", l);
  };
}

class FakeThunderbird {
  /**
   * @param {object} [o]
   * @param {string} [o.src]       directory holding the add-on source (default: ../../src or TNOTE_SRC)
   * @param {object} [o.manifest]  parsed manifest (default: <src>/manifest.json)
   * @param {object} [o.config]    behaviour switches, see below
   */
  constructor({ src = SRC, manifest = readManifest(src), config = {} } = {}) {
    this.src = src;
    const schemas = thunderbirdSchemas();
    if (!schemas.ok) throw new Error(schemas.reason);
    this.schemas = schemas;
    this.root = schemas.root;
    this.manifest = manifest;
    this.extensionId = manifest.browser_specific_settings?.gecko?.id;
    this.baseUrl = BASE_URL;
    this.config = {
      // The message header "Note" button is in the header toolbar (not removed).
      messageDisplayActionButton: true,
      // The tNOTE button is in the unified toolbar of the mail space.
      browserActionButton: true,
      // An opened popup panel, popup window or extension tab gets as far as
      // running note.js.
      popupLoads: true,
      // The window manager focuses new windows (false models Cinnamon/X11
      // focus-stealing prevention, where windows.create waits forever).
      windowFocusArrives: true,
      // MODEL: fake time before a document in a minimized window gets an
      // animation frame (Gecko throttles a minimized window's refresh driver;
      // the cadence is not taken from the source). A real-Thunderbird run with
      // a minimized second main window measured browserAction.setPopup
      // answering after 1101 ms and 5019 ms (and after 10 ms and 9 ms once it
      // had been minimized for 90 s and 180 s), and the toolbar panel of
      // v0.4.1 opening after 3175 ms (scratchpad
      // tb-integration/v041adv/mn-w41.log, mn-t41.log T1).
      throttledFrameMs: 1000,
      ...config,
    };

    this.calls = [];
    this.faults = {};
    this.holds = {};
    this.violations = [];
    this.warnings = [];
    this.missing = [];
    this.listeners = [];
    this.consoleMessages = [];
    this.unhandled = [];
    this.contexts = [];
    this.popups = [];
    this.displayPages = [];
    this.displayScripts = [];
    this.menuItems = new Map();
    this.menuRefreshes = 0;
    this.nextMenuItemId = 1;
    this.storage = new Map();
    this.tags = structuredClone(DEFAULT_TAGS);
    this.messages = new Map();
    this.nextMessageId = 1; // ExtensionMessages.sys.mjs:1102, 1316: a per-session counter.
    this.windows = new Map();
    this.tabs = new Map();
    this.nextWindowId = 1;
    this.nextTabId = 1;
    this.clock = new FakeClock();
    // requestAnimationFrame callbacks still waiting for their document to paint.
    this.frameWaiters = [];
    this.framesScheduled = false;

    this.mainWindow = this.addWindow("normal");
    this.mailTab = this.addTab(this.mainWindow.id, "mail");
    this.topWindowId = this.mainWindow.id;
    this.initActions();

    this.builder = new ApiBuilder({ root: this.root, manifest, impl: this.implementation(), world: this });
    this.releaseRejections = captureRejections(this);
  }

  // ---------------------------------------------------------------- model --

  // type: "normal" (messenger.xhtml), "messageDisplay" (messageWindow.xhtml)
  // or "popup" (an extension popup window). state: windows.WindowState.
  addWindow(type) {
    const w = { id: this.nextWindowId++, type, tabIds: [], state: "normal" };
    this.windows.set(w.id, w);
    return w;
  }

  addTab(windowId, type, extra = {}) {
    // msgLoaded mirrors about:message's window.msgLoaded (aboutMessage.js:229,
    // :253): false while a message is still being displayed; loadWaiters are
    // getDisplayedMessage calls waiting for it (ext-messageDisplay.js:220-231).
    const t = { id: this.nextTabId++, windowId, type, active: true, selected: [], url: null, msgLoaded: true, loadWaiters: [], ...extra };
    // A mail tab's reading pane (about:3pane message pane) starts out shown.
    if (type === "mail" && t.messagePaneVisible === undefined) t.messagePaneVisible = true;
    const w = this.windows.get(windowId);
    for (const other of w.tabIds) this.tabs.get(other).active = false;
    w.tabIds.push(t.id);
    this.tabs.set(t.id, t);
    this.scheduleFrames();
    return t;
  }

  // tabmail.js:1026-1091 (closeTab): the tab type's closeTab destroys the
  // browser (specialTabs.js:440-456, which unloads the page), the tab leaves
  // the strip, and the tab that opened it (else the neighbour) is selected.
  removeTab(tab) {
    const w = this.windows.get(tab.windowId);
    const i = w.tabIds.indexOf(tab.id);
    if (i < 0) return;
    w.tabIds.splice(i, 1);
    this.tabs.delete(tab.id);
    if (tab.active && w.tabIds.length) {
      const opener = tab.openerTabId && w.tabIds.includes(tab.openerTabId) ? tab.openerTabId : w.tabIds[i === w.tabIds.length ? i - 1 : i];
      for (const id of w.tabIds) this.tabs.get(id).active = id === opener;
    }
    this.scheduleFrames();
  }

  /**
   * The user opens another main (3-pane) window. It has one mail tab showing
   * no message (so its about:message is hidden) and takes focus.
   */
  openMainWindow() {
    const w = this.addWindow("normal");
    const tab = this.addTab(w.id, "mail");
    this.topWindowId = w.id;
    return { window: w, tab };
  }

  /**
   * The user opens another mail tab (for example a folder in a new tab). It
   * shows no message yet. background: true leaves the current tab selected.
   */
  openMailTab({ windowId = this.mainWindow.id, background = false } = {}) {
    const current = this.activeTab(windowId);
    const tab = this.addTab(windowId, "mail");
    if (background && current) {
      tab.active = false;
      current.active = true;
    }
    this.scheduleFrames();
    return tab;
  }

  /** The user selects a tab in its window. */
  selectTab(tab) {
    for (const id of this.windows.get(tab.windowId).tabIds) this.tabs.get(id).active = id === tab.id;
    this.scheduleFrames();
  }

  /**
   * The window manager minimizes or restores a window. MODEL: minimizing the
   * active window makes another, unminimized window the active one.
   */
  setWindowState(w, state) {
    w.state = state;
    if (state === "minimized" && this.topWindowId === w.id) {
      const other = [...this.windows.values()].find((x) => x.id !== w.id && x.state !== "minimized");
      if (other) this.topWindowId = other.id;
    }
    this.scheduleFrames();
  }

  addMessage({ subject = "Hello", headerMessageId, tags = [], external = false, author = "Ann <ann@example.com>" } = {}) {
    const id = this.nextMessageId++;
    const m = {
      id,
      subject,
      author,
      headerMessageId: headerMessageId === undefined ? `msg${id}@example.com` : headerMessageId,
      keywords: [...tags],
      external,
      date: Date.UTC(2026, 9, 1, 9, id),
      read: true,
      flagged: false,
      junk: false,
    };
    this.messages.set(id, m);
    return this.header(id);
  }

  // ExtensionMessages.sys.mjs:2131-2160 (MessageHeader conversion).
  header(id) {
    const m = this.messages.get(id);
    const h = {
      id: m.id,
      date: new Date(m.date),
      author: m.author,
      recipients: ["me@example.com"],
      ccList: [],
      bccList: [],
      subject: m.subject,
      read: m.read,
      new: false,
      headersOnly: false,
      flagged: m.flagged,
      junk: m.junk,
      junkScore: m.junk ? 100 : 0,
      headerMessageId: m.headerMessageId,
      size: 1234,
      // "Keep sort order from allTags": only known tag keys, in tag-list order.
      tags: this.tags.map((t) => t.key).filter((k) => m.keywords.includes(k)),
      external: m.external,
      priority: "none",
    };
    if (!m.external) h.folder = structuredClone(INBOX);
    return h;
  }

  tabInfo(tab) {
    return {
      id: tab.id,
      index: this.windows.get(tab.windowId).tabIds.indexOf(tab.id),
      windowId: tab.windowId,
      highlighted: tab.active,
      active: tab.active,
      status: "complete",
      type: tab.type,
      mailTab: tab.type === "mail",
    };
  }

  windowInfo(w) {
    return {
      id: w.id,
      focused: w.id === this.topWindowId,
      incognito: false,
      alwaysOnTop: false,
      type: w.type,
      state: w.state,
      tabs: w.tabIds.map((id) => this.tabInfo(this.tabs.get(id))),
    };
  }

  activeTab(windowId) {
    const w = this.windows.get(windowId);
    return w && w.tabIds.map((id) => this.tabs.get(id)).find((t) => t.active);
  }

  // ext-messageDisplay.js:24-36 and :255-265. Returns the message ids shown in
  // a tab: the selection for a mail tab, the one message for a message tab/window.
  // With the reading pane hidden nothing is shown: collapsing it clears the
  // message browser (pane-layout.mjs:93-104 -> message-pane.mjs:184-187,
  // :239-249, :289-297 -> aboutMessage.js:227-254 sets gMessage = null), a new
  // selection is not displayed (about3Pane.js:5308-5311), and
  // getMessageDisplayTab() then returns null (ext-messageDisplay.js:235-236).
  displayedIds(tab) {
    if (!tab) return [];
    if (tab.type === "mail") return tab.messagePaneVisible ? tab.selected : [];
    if (tab.type === "messageDisplay") return tab.selected;
    return [];
  }

  // ext-messageDisplayAction.js:197-224: the header button only exists where a
  // single message is shown, and triggerAction() fails while about:3pane's
  // messageBrowser is hidden. MODEL: in a mail tab that is when exactly one
  // message is selected and the reading pane is shown (with none or several
  // selected, about:3pane hides messageBrowser).
  messagePaneShowsOne(windowId) {
    const tab = this.activeTab(windowId);
    return !!tab && (tab.type === "mail" || tab.type === "messageDisplay") && this.displayedIds(tab).length === 1;
  }

  /** The user shows or hides the reading pane (View > Layout > Message Pane). */
  setMessagePaneVisible(visible, { tab = this.mailTab } = {}) {
    tab.messagePaneVisible = visible;
    // Hiding clears the message browser, which sets msgLoaded again
    // (aboutMessage.js:247-254). MODEL: whether that also fires "MsgLoaded"
    // for calls already waiting is not verified, so they keep waiting.
    tab.msgLoaded = true;
    this.scheduleFrames();
    if (visible && tab.selected.length === 1) return this.runDisplayScripts(tab);
    return null;
  }

  // ------------------------------------------------------------- contexts --

  createContext(name, envType, url, extra = {}) {
    const ctx = { name, envType, url, closed: false, ...extra };
    ctx.api = this.builder.build(ctx);
    this.contexts.push(ctx);
    return ctx;
  }

  fakeConsole(ctxName) {
    const out = {};
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      out[level] = (...args) => this.consoleMessages.push({ context: ctxName, level, args });
    }
    return out;
  }

  /** Runs the manifest's background scripts in a fresh vm context. */
  startBackground() {
    const ctx = this.createContext("background", "addon_child", BASE_URL + "_generated_background_page.html");
    const sandbox = {
      messenger: ctx.api,
      browser: ctx.api,
      console: this.fakeConsole("background"),
      URL,
      URLSearchParams,
      structuredClone,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const vmContext = vm.createContext(sandbox);
    this.clock.install(sandbox, { Date: vm.runInContext("Date", vmContext) }, (e) =>
      this.consoleMessages.push({ context: "background", level: "error", args: [String(e)] })
    );
    for (const rel of this.manifest.background.scripts) {
      vm.runInContext(readSource(rel, this.src), vmContext, { filename: path.join(this.src, rel) });
    }
    this.background = { ctx, vmContext };
    return this.background;
  }

  /** Reads a top-level binding of background.js (for white-box checks only). */
  bg(expr) {
    return vm.runInContext(expr, this.background.vmContext);
  }

  jsdom() {
    try {
      return require("jsdom");
    } catch {
      throw new Error("jsdom is missing: run `npm install` in tests/");
    }
  }

  /**
   * Loads note.html (or another extension page) the way a popup panel, popup
   * window or tab would, running its <script src> files against a
   * schema-checked API.
   *
   * Closing: window.close() only asks the embedder to close the page; Gecko
   * sends DOMWindowClose to the chrome side, which closes the panel
   * (ExtensionPopups.sys.mjs:214-216 -> :458-460, then popuphiding -> destroy
   * removes the browser, :176-177, :70-88) or the content tab
   * (specialTabs.js:517-530 -> tabmail.closeTab). Removing the browser unloads
   * the document, which fires "pagehide" while the extension context is still
   * active (ExtensionCommon.sys.mjs:595-612: active while the window global is
   * current). MODEL: messages sent from that pagehide handler are delivered
   * (each runtime.sendMessage is handed to IPC when called); whether real
   * Thunderbird delivers them during browser teardown is not verified here.
   * @param {Function} [o.onClose]  chrome-side close (panel hides, tab closes); default: page.hide()
   */
  loadExtensionPage(relUrl, { name, windowId = null, tab = null, onClose = null } = {}) {
    const { JSDOM, VirtualConsole } = this.jsdom();
    const url = new URL(relUrl, BASE_URL).href;
    const file = new URL(url).pathname.replace(/^\//, "");
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (e) => this.consoleMessages.push({ context: name, level: "jsdomError", args: [e.message] }));
    for (const level of ["log", "info", "warn", "error"]) {
      virtualConsole.on(level, (...args) => this.consoleMessages.push({ context: name, level, args }));
    }
    const dom = new JSDOM(readSource(file, this.src), { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
    const ctx = this.createContext(name, "addon_child", url, { windowId, tab });
    const win = dom.window;
    win.browser = ctx.api;
    win.messenger = ctx.api;
    this.clock.install(win, { Date: win.Date }, (e) => this.consoleMessages.push({ context: name, level: "jsdomError", args: [String(e)] }));
    const page = { name, url, dom, window: win, document: win.document, ctx, closed: false, closeRequested: false, windowId, tab, destroy: win.close.bind(win) };
    /** The page is unloaded: "pagehide" fires, then the context goes away. */
    page.hide = () => {
      if (page.closed) return;
      page.closed = true;
      win.dispatchEvent(new win.PageTransitionEvent("pagehide", { persisted: false }));
      ctx.closed = true;
    };
    win.close = () => {
      if (page.closeRequested || page.closed) return;
      page.closeRequested = true;
      setImmediate(() => (onClose ? onClose(page) : page.hide()));
    };
    // MODEL: window.focus() asks Gecko to raise the page's window and focus the
    // page. Whether that is honoured for an extension panel or content tab
    // (dom.disable_window_flip, the window manager's focus-stealing prevention)
    // is not modelled; jsdom has no window focus at all and only logs "Not
    // implemented". The fake records the request, and every element focus()
    // call, in order, so tests can check what the page asked for.
    page.focusLog = [];
    win.focus = () => {
      page.focusLog.push("window");
    };
    const elementFocus = win.HTMLElement.prototype.focus;
    win.HTMLElement.prototype.focus = function (...args) {
      page.focusLog.push(this.id ? `#${this.id}` : this.localName);
      return elementFocus.apply(this, args);
    };
    const vmContext = dom.getInternalVMContext();
    for (const script of [...win.document.querySelectorAll("script[src]")]) {
      const src = new URL(script.getAttribute("src"), url).pathname.replace(/^\//, "");
      vm.runInContext(readSource(src, this.src), vmContext, { filename: path.join(this.src, src) });
    }
    return page;
  }

  // Opens a page as an action's popup panel (ExtensionToolbarButtons.sys.mjs:603-621):
  // a new ViewPopup for popupURL, the URL triggerAction read from the action's
  // context data. `destroyed` mirrors BasePopup.destroy (ExtensionPopups.sys.mjs:70-80),
  // which removes the panel from BasePopup.instances.
  openPopupPanel(kind, windowId, popupUrl) {
    const url = new URL(popupUrl, BASE_URL).href;
    const record = { kind, windowId, url, loaded: false, dismissed: false, destroyed: false, page: null };
    this.popups.push(record);
    if (this.config.popupLoads) {
      setImmediate(() => {
        if (record.dismissed) return; // closed before its browser loaded
        record.page = this.loadExtensionPage(url, {
          name: `${kind} popup`,
          windowId,
          // DOMWindowClose -> closePopup -> popuphiding -> destroy (ExtensionPopups.sys.mjs:214-216, :176-180).
          onClose: (page) => {
            record.destroyed = true;
            page.hide();
          },
        });
        record.loaded = true;
      });
    }
    return record;
  }

  /** The popup panel of this add-on still open in a window, if any (BasePopup.for, ExtensionPopups.sys.mjs:62-64). */
  openPanelIn(windowId) {
    return this.popups.find((p) => PANEL_KINDS.has(p.kind) && p.windowId === windowId && !p.destroyed) || null;
  }

  /**
   * The user closes an open editor without using its buttons: clicks outside a
   * panel or presses its close key (popuphiding -> destroy,
   * ExtensionPopups.sys.mjs:176-177, :70-88), or closes the editor's tab. A
   * panel dismissed before its page loaded never runs note.js.
   */
  dismissPopup(record) {
    record.dismissed = true;
    if (PANEL_KINDS.has(record.kind)) record.destroyed = true;
    if (!record.page) return;
    if (record.kind === "tab") this.closeTabPage(record);
    else record.page.hide();
  }

  // MODEL: an open arrow panel rolls up when the user clicks elsewhere in its
  // window, here the message list (popuphiding -> destroy, ExtensionPopups.sys.mjs:176-180).
  rollUpPanels(windowId) {
    for (const p of this.popups) {
      if (PANEL_KINDS.has(p.kind) && p.windowId === windowId && !p.destroyed) this.dismissPopup(p);
    }
  }

  // specialTabs.js:440-456 + tabmail.js:1076-1091: the page unloads, then the
  // tab leaves the window and the opener tab is selected again.
  closeTabPage(record) {
    record.page.hide();
    const tab = this.tabs.get(record.tabId);
    if (tab) this.removeTab(tab);
  }

  /**
   * Selects messages in a tab, then (when a single message is displayed) runs
   * registered message display scripts in a document for that message.
   * @param {boolean} [o.loaded]  false: the message starts displaying but has
   *   not finished (a slow or stalled body load) until finishMessageLoad(tab).
   */
  selectMessages(ids, { tab = this.mailTab, loaded = true } = {}) {
    tab.selected = [...ids];
    this.scheduleFrames(); // about:message is shown or hidden with the selection
    if (this.displayedIds(tab).length !== 1) return null;
    // displayMessage() clears msgLoaded for every new message (aboutMessage.js:226-229).
    tab.msgLoaded = false;
    if (!loaded) return null;
    return this.finishMessageLoad(tab);
  }

  /**
   * The displayed message finishes loading ("MsgLoaded"): getDisplayedMessage
   * calls waiting for it resume with what is displayed now
   * (ext-messageDisplay.js:220-234), and message display scripts run.
   * MODEL: display scripts run once the message has loaded.
   */
  finishMessageLoad(tab = this.mailTab) {
    tab.msgLoaded = true;
    for (const resume of tab.loadWaiters.splice(0)) resume();
    return this.displayedIds(tab).length === 1 ? this.runDisplayScripts(tab) : null;
  }

  openMessageWindow(id) {
    const w = this.addWindow("messageDisplay");
    const tab = this.addTab(w.id, "messageDisplay", { selected: [id] });
    this.topWindowId = w.id;
    return { window: w, tab, page: this.runDisplayScripts(tab) };
  }

  runDisplayScripts(tab) {
    if (!this.displayScripts.length) return null;
    const { JSDOM } = this.jsdom();
    const msgId = tab.selected[0];
    const dom = new JSDOM(
      `<!doctype html><html><head><style>p { color: red }</style></head><body><p id="email">Dear Alex, the invoice is attached.</p></body></html>`,
      { url: `mailbox:///home/user/Inbox?number=${msgId}`, runScripts: "outside-only" }
    );
    const win = dom.window;
    this.clock.install(win, { Date: win.Date }, (e) => this.consoleMessages.push({ context: `content (tab ${tab.id})`, level: "jsdomError", args: [String(e)] }));
    // Test hook: keep a handle on closed shadow roots so the bar can be read.
    const shadowRoots = [];
    const attach = win.Element.prototype.attachShadow;
    win.Element.prototype.attachShadow = function (init) {
      const root = attach.call(this, init);
      shadowRoots.push({ host: this, root });
      return root;
    };
    const ctx = this.createContext(`content (tab ${tab.id})`, "content_child", win.location.href, {
      tab,
      sender: { tab: this.tabInfo(tab), frameId: 0 },
    });
    win.browser = ctx.api;
    win.messenger = ctx.api;
    const page = { tab, msgId, dom, window: win, document: win.document, ctx, shadowRoots };
    this.displayPages.push(page);
    const vmContext = dom.getInternalVMContext();
    for (const reg of this.displayScripts) {
      for (const js of reg.js || []) {
        const rel = new URL(js.file).pathname.replace(/^\//, "");
        vm.runInContext(readSource(rel, this.src), vmContext, { filename: path.join(this.src, rel) });
      }
    }
    return page;
  }

  // ---------------------------------------------------------------- events --

  /** Fires an event to listeners in matching contexts; returns their results. */
  fire(event, args, { contexts } = {}) {
    const matching = this.listeners.filter((l) => l.event === event && !l.ctx.closed && (!contexts || contexts(l.ctx)));
    if (matching.length) {
      const l = matching[0];
      this.builder.checkEventArgs(l.schema, l.ns, event, args);
    }
    return matching.map((l) => l.fn(...args.map((a) => structuredClone(a))));
  }

  messageList(ids) {
    return { id: null, messages: ids.map((id) => this.header(id)) };
  }

  /** The user opens the message list context menu on these messages. */
  async rightClick(ids, { tab = this.mailTab } = {}) {
    // MODEL: the user works in this window, so it is the active one (as for
    // clickActionButton).
    this.topWindowId = tab.windowId;
    this.rollUpPanels(tab.windowId);
    // ext-menus.js:1387-1393 builds {menuIds, contexts}; :794 adds
    // selectedMessages only with messagesRead. Thunderbird-only contexts such as
    // message_list are not part of "all" (ext-menus.js:682).
    const menuIds = [...this.menuItems.values()]
      .filter((i) => i.visible && i.contexts.includes("message_list"))
      .map((i) => i.id);
    if (!menuIds.length) return [];
    const info = { menuIds, contexts: ["message_list"], editable: false };
    if (this.builder.hasPermission("messagesRead")) info.selectedMessages = this.messageList(ids);
    return Promise.all(this.fire("menus.onShown", [info, this.tabInfo(tab)]));
  }

  /** The user clicks a menu item in the message list context menu. */
  async clickMenuItem(menuItemId, ids, { tab = this.mailTab } = {}) {
    const item = this.menuItems.get(menuItemId);
    if (!item) throw new FakeError(`no menu item ${menuItemId}`);
    if (!item.enabled) throw new FakeError(`menu item ${menuItemId} is disabled and cannot be clicked`);
    this.topWindowId = tab.windowId; // MODEL: see rightClick
    this.rollUpPanels(tab.windowId);
    const info = { menuItemId, editable: false, modifiers: [], button: 0 };
    if (this.builder.hasPermission("messagesRead")) info.selectedMessages = this.messageList(ids);
    return Promise.all(this.fire("menus.onClicked", [info, this.tabInfo(tab)]));
  }

  /**
   * The user clicks an action button (handleEvent -> triggerAction,
   * ExtensionToolbarButtons.sys.mjs:640-660). The page that opens is the
   * action's current popup URL for the window's active tab, not necessarily
   * the manifest's default_popup. Returns the panel record, or null when the
   * popup URL is "" (the click then only emits onClicked, :622-627).
   */
  clickActionButton(kind, windowId = this.topWindowId) {
    const ready = this.actionReady(kind, windowId);
    if (!ready) throw new FakeError(`${kind} button is not available (or disabled) in window ${windowId}`);
    if (this.openPanelIn(windowId)) throw new FakeError("not modelled: clicking a button while a panel is open (the click rolls the panel up)");
    // MODEL: clicking in a window makes it the active window, so focusWindow
    // (:582-596) has nothing to wait for.
    this.topWindowId = windowId;
    return this.actionOpen(kind, windowId, ready.popupURL, { requirePopupUrl: false }).record;
  }

  messageDisplayActionAvailable(windowId) {
    return this.config.messageDisplayActionButton && this.messagePaneShowsOne(windowId);
  }

  // ------------------------------------------------------------ actions --

  // ToolbarButtonAPI keeps per-action defaults (ExtensionToolbarButtons.sys.mjs:251-261),
  // global values whose prototype is the defaults (:261), and per-tab values
  // whose prototype is the globals (TabContext.get, ext-mail.js:223-249, with
  // getContextData(null) as default prototype, :217-219). default_popup is a
  // "relativeUrl" (browserAction.json, messageDisplayAction.json), which
  // manifest normalisation resolves against the add-on's base URL
  // (Schemas.sys.mjs:1216-1230, context url from Extension.sys.mjs:1708).
  initActions() {
    this.actions = {};
    for (const [kind, key] of ACTION_KEYS) {
      const entry = this.manifest[key];
      if (!entry) continue;
      const defaults = { enabled: true, popup: entry.default_popup ? new URL(entry.default_popup, BASE_URL).href : "" };
      this.actions[kind] = { defaults, globals: Object.create(defaults), tabData: new Map() };
    }
  }

  /** getContextData (:859-864): null target -> the globals, else the tab's values. */
  actionData(kind, target) {
    const a = this.actions[kind];
    if (target === null) return a.globals;
    if (!a.tabData.has(target)) a.tabData.set(target, Object.create(a.globals));
    return a.tabData.get(target);
  }

  /**
   * getTargetFromWindow (:814-827): the window's current tab (for the header
   * button, the tab whose about:3pane or message tab holds about:message), or
   * the window itself for a message window, which the fake represents by its
   * only tab.
   */
  actionTarget(windowId) {
    return this.activeTab(windowId)?.id ?? null;
  }

  /** The popup URL a click on the action button would open now in that window. */
  popupUrl(kind, windowId = this.topWindowId) {
    return this.actionData(kind, this.actionTarget(windowId)).popup;
  }

  /**
   * The synchronous start of triggerAction (:576-600) with the header button's
   * override (ext-messageDisplayAction.js:197-225, which calls super without
   * awaiting anything first). The popup URL and enabled state are read here,
   * before triggerAction awaits the window's focus (:577-580 vs :601).
   * Returns null when the action does nothing, else { popupURL }.
   */
  actionReady(kind, windowId) {
    if (!this.actions[kind]) return null;
    let button;
    if (kind === "messageDisplayAction") {
      // Only where about:message is shown (see messagePaneShowsOne).
      if (!this.messagePaneShowsOne(windowId)) return null;
      button = this.config.messageDisplayActionButton;
    } else {
      button = this.browserActionAvailable(windowId);
    }
    const { popup: popupURL, enabled } = this.actionData(kind, this.actionTarget(windowId));
    if (!button || !enabled) return null;
    return { popupURL };
  }

  /** The rest of triggerAction once the window has focus (:603-631). */
  actionOpen(kind, windowId, popupURL, { requirePopupUrl }) {
    if (popupURL) {
      // ViewPopup.for (:605-607): a panel of this add-on that is still open in
      // the window is shown again as it is, whatever popupURL now says.
      const record = this.openPanelIn(windowId) || this.openPopupPanel(kind, windowId, popupURL);
      return { success: true, record };
    }
    // Without a popup a click emits onClicked (:622-627); openPopup asks for
    // requirePopupUrl and fails instead (:1087-1089). tNOTE has no onClicked listener.
    return { success: !requirePopupUrl, record: null };
  }

  /** openPopup() from the API (:1064-1091): resolves to triggerAction's result. */
  triggerActionFromApi(kind, windowId) {
    const ready = this.actionReady(kind, windowId);
    if (!ready) return false;
    // focusWindow (:582-601) resolves at once when the window is already the
    // active one, but triggerAction still awaits it before opening the panel.
    let focused;
    if (windowId === this.topWindowId) {
      focused = Promise.resolve();
    } else if (this.config.windowFocusArrives) {
      // MODEL: win.focus() gives an existing window focus on the next turn.
      focused = new Promise((resolve) => setImmediate(resolve)).then(() => {
        this.topWindowId = windowId;
      });
    } else {
      // The "focus" event never comes (focus-stealing prevention): triggerAction never settles.
      focused = new Promise(() => {});
    }
    return focused.then(() => this.actionOpen(kind, windowId, ready.popupURL, { requirePopupUrl: true }).success);
  }

  /**
   * What a setter such as setPopup waits for after storing its value:
   * setProperty awaits updateOnChange(target) (ExtensionToolbarButtons.sys.mjs:877-887).
   * - target null (a global value, :796-804): updateWindow for every open
   *   window whose URL is one of the action's windowURLs;
   * - a tab (:786-795): only when it is its window's selected tab, else
   *   nothing; the header button repaints just that tab's about:message
   *   (ext-messageDisplayAction.js:119-146).
   * A message window is its own target (getTargetFromWindow, :814-818); the
   * fake names it by its only tab.
   */
  actionRepaint(kind, target) {
    if (target === null) {
      return Promise.all(this.actionWindowIds(kind).map((id) => this.actionUpdateWindow(kind, id)));
    }
    const tab = this.tabs.get(target);
    const w = this.windows.get(tab.windowId);
    if (w.type === "messageDisplay") return this.actionUpdateWindow(kind, w.id);
    if (!tab.active) return Promise.resolve();
    if (kind === "messageDisplayAction") {
      return this.hasAboutMessage(tab) ? this.requestFrame({ tabId: tab.id }) : Promise.resolve();
    }
    return this.actionUpdateWindow(kind, w.id);
  }

  /**
   * updateWindow: one animation frame in the window itself
   * (ExtensionToolbarButtons.sys.mjs:767-774), or for the header button one in
   * every about:message of the window, shown or not
   * (ext-messageDisplayAction.js:105-113).
   */
  actionUpdateWindow(kind, windowId) {
    if (kind === "messageDisplayAction") {
      const docs = this.windows.get(windowId).tabIds.map((id) => this.tabs.get(id)).filter((t) => this.hasAboutMessage(t));
      return Promise.all(docs.map((t) => this.requestFrame({ tabId: t.id })));
    }
    return this.requestFrame({ windowId });
  }

  /**
   * The open windows an action lives in (its windowURLs): the header button in
   * main and message windows (ext-messageDisplayAction.js:38-41); the toolbar
   * button in the windows of its default_windows, ["normal"] by default
   * (ext-browserAction.js:182-188, browserAction.json:157-166).
   */
  actionWindowIds(kind) {
    const types = kind === "messageDisplayAction" ? ["normal", "messageDisplay"] : this.manifest.browser_action?.default_windows || ["normal"];
    return [...this.windows.values()].filter((w) => types.includes(w.type)).map((w) => w.id);
  }

  /**
   * Whether a tab holds an about:message document: every mail tab does (the
   * about:3pane's messageBrowser loads it at once, hidden until one message
   * is displayed, about3Pane.xhtml:502-504), and so does a message tab or
   * message window.
   */
  hasAboutMessage(tab) {
    return tab.type === "mail" || tab.type === "messageDisplay";
  }

  // ------------------------------------------------------------- frames --
  // A requestAnimationFrame callback runs only when its document is painted.
  // The reviewer's real-Thunderbird run showed that a hidden about:message
  // never answers (a background mail tab, or a second main window showing no
  // message: tb-integration/v041adv/mn-t41.log T2, T3), and that a minimized
  // window answers seconds later (T1, mn-w41.log).
  // MODEL: a shown document paints on the next turn of the event loop; one in
  // a minimized window after config.throttledFrameMs of fake time; a hidden
  // one only once it is shown again.

  /** "shown", "throttled" or "hidden" for { windowId } or { tabId } (that tab's about:message). */
  paintState(doc) {
    const tab = doc.tabId != null ? this.tabs.get(doc.tabId) : null;
    if (doc.tabId != null && !tab) return "hidden"; // the tab was closed
    const w = this.windows.get(tab ? tab.windowId : doc.windowId);
    if (!w) return "hidden";
    if (tab && !this.aboutMessageShown(tab)) return "hidden";
    return w.state === "minimized" ? "throttled" : "shown";
  }

  // An about:message is shown when its tab is the selected one (tabmail shows
  // only that tab's panel) and, in a mail tab, while exactly one message is
  // displayed: message-pane.mjs shows messageBrowser for one message
  // (:329-331) and hides it otherwise (:289-296); see also messagePaneShowsOne.
  aboutMessageShown(tab) {
    if (this.windows.get(tab.windowId).type === "messageDisplay") return true;
    if (!tab.active) return false;
    if (tab.type === "messageDisplay") return true;
    return tab.type === "mail" && this.displayedIds(tab).length === 1;
  }

  /** window.requestAnimationFrame in that document, as a promise. */
  requestFrame(doc) {
    return new Promise((resolve) => {
      this.frameWaiters.push({ doc, resolve, throttledSince: null, timer: null });
      this.scheduleFrames();
    });
  }

  /** Re-checks waiting frames on the next turn (after anything that shows, hides or minimizes). */
  scheduleFrames() {
    if (this.framesScheduled || this.disposed || !this.frameWaiters?.length) return;
    this.framesScheduled = true;
    setImmediate(() => {
      this.framesScheduled = false;
      this.runFrames();
    });
  }

  runFrames() {
    if (this.disposed) return;
    const now = this.clock.now();
    for (const f of [...this.frameWaiters]) {
      const state = this.paintState(f.doc);
      if (state === "hidden") {
        f.throttledSince = null;
        continue;
      }
      if (state === "throttled") {
        f.throttledSince ??= now;
        const due = f.throttledSince + this.config.throttledFrameMs;
        if (now < due) {
          if (f.timer === null) {
            f.timer = this.clock.setTimeout(() => {
              f.timer = null;
              this.runFrames();
            }, due - now, []);
          }
          continue;
        }
      }
      this.frameWaiters.splice(this.frameWaiters.indexOf(f), 1);
      if (f.timer !== null) this.clock.clearTimeout(f.timer);
      f.resolve();
    }
  }

  /** Frame requests still waiting, as { windowId } / { tabId } (for tests). */
  pendingFrames() {
    return this.frameWaiters.map((f) => ({ ...f.doc }));
  }

  /**
   * Test hook: calls to `api` made from now on stay unanswered until
   * release(), as if the parent process had not got to them yet.
   * The fake runs a held call's implementation only on release, so later
   * calls from the same page could overtake it; the real parent handles one
   * page's calls in order (one IPC message each, ExtensionChild.sys.mjs:925-947).
   * That makes no difference where the implementation only answers late, but
   * setPopup stores its value at once, so holding it is refused: use
   * frames (pendingFrames, setWindowState, openMailTab) to delay its answer.
   */
  hold(api) {
    if (/\.setPopup$/.test(api)) throw new FakeError(`hold(${api}) is not modelled: setPopup stores its value when the parent gets the call`);
    let open;
    const promise = new Promise((resolve) => (open = resolve));
    const h = {
      promise,
      release: () => {
        if (this.holds[api] === h) delete this.holds[api];
        open();
      },
    };
    this.holds[api] = h;
    return h;
  }

  // ext-browserAction.js:53-67: in the main window only the unified toolbar
  // button counts; popup windows have no toolbar for it.
  browserActionAvailable(windowId) {
    const w = this.windows.get(windowId);
    return this.config.browserActionButton && w && w.type === "normal";
  }

  storageChanged(changes) {
    // ExtensionStorageIDB.sys.mjs:345-356 / :489-497 produce the changes;
    // listeners run after the call has completed.
    setImmediate(() => {
      this.fire("storage.onChanged", [changes, "local"]);
      this.fire("storage.local.onChanged", [changes]);
    });
  }

  senderFor(ctx) {
    // ExtensionParent.sys.mjs getSender; only MessageSender schema fields.
    const sender = { id: this.extensionId, url: ctx.url };
    if (ctx.sender) Object.assign(sender, ctx.sender);
    else if (ctx.tab) Object.assign(sender, { tab: this.tabInfo(ctx.tab), frameId: 0 });
    return sender;
  }

  // ExtensionChild.sys.mjs:158-215 (MessageEvent.emit / wrapResponse) and
  // ExtensionParent.sys.mjs:390-401 (no response => ERROR_NO_RECEIVERS).
  deliverRuntimeMessage(message, fromCtx) {
    const targets = this.listeners.filter(
      (l) => l.event === "runtime.onMessage" && l.ctx !== fromCtx && !l.ctx.closed && l.ctx.envType !== "content_child"
    );
    const sender = this.senderFor(fromCtx);
    const responses = [];
    for (const l of targets) {
      this.builder.checkEventArgs(l.schema, l.ns, "runtime.onMessage", [message, sender]);
      let resolve;
      const p = new Promise((r) => (resolve = r));
      let responded;
      const sendResponse = (v) => {
        resolve(v);
        responded = p;
      };
      let result;
      try {
        result = l.fn(structuredClone(message), structuredClone(sender), sendResponse);
      } catch (e) {
        responses.push(Promise.reject(e));
        continue;
      }
      if (isPromise(result)) responses.push(result);
      else if (result === true) responses.push(p);
      else if (responded) responses.push(responded);
    }
    if (!responses.length) return Promise.reject(new ExtensionError(ERROR_NO_RECEIVERS));
    return Promise.race(responses).then(
      (v) => structuredClone(v),
      (e) => {
        throw new ExtensionError(e?.message ?? "An unexpected error occurred");
      }
    );
  }

  // --------------------------------------------------------- API surface --

  implementation() {
    const tb = this;
    const lower = (s) => s.toLowerCase();
    const tagByKey = (key) => tb.tags.find((t) => t.key == key);
    const getMsg = (id) => {
      const m = tb.messages.get(id);
      if (!m) throw new ExtensionError(`Message not found: ${id}.`);
      return m;
    };
    const resolveWindow = (options) => {
      if (options?.windowId) {
        const w = tb.windows.get(options.windowId);
        if (!w) throw new ExtensionError(`Invalid window ID: ${options.windowId}`);
        return w;
      }
      return tb.windows.get(tb.topWindowId);
    };
    // getTargetFromDetails (ExtensionToolbarButtons.sys.mjs:842-850) with
    // tabTracker.getTab (ext-mail.js:556-565). The schema already rejects
    // windowId as unsupported, so the first check is only reached by a fake bug.
    const actionTargetFromDetails = (details) => {
      if (details.windowId != null) throw new ExtensionError("windowId is not allowed, use tabId instead.");
      if (details.tabId != null) {
        if (!tb.tabs.has(details.tabId)) throw new ExtensionError(`Invalid tab ID: ${details.tabId}`);
        return details.tabId;
      }
      return null;
    };
    // ExtensionCommon.sys.mjs:724-731: the add-on's own URLs always pass.
    // MODEL: other URLs go through checkLoadURIWithPrincipal, not modelled.
    const checkLoadURL = (url) => {
      if (url.startsWith(BASE_URL)) return true;
      throw new FakeError(`checkLoadURL(${url}) is not modelled`);
    };
    const actionApi = (kind) => ({
      // :998-1016. The popup is resolved against the calling page's URL, and
      // stored with setProperty (:877-890): null deletes the value (back to
      // the manifest's), "" means "no popup". The value is stored before
      // setProperty's first await (:878-884), so a call that comes after this
      // one (openPopup reads the URL at :578) sees it at once; the answer
      // comes only after updateOnChange (:886), which waits for animation
      // frames (actionRepaint) and never comes while a matching
      // about:message is hidden. Before calling setPopup the parent awaits
      // asyncFindAPIPath (ExtensionParent.sys.mjs:1292), which every API call
      // goes through, so calls are still taken in the order sent.
      [`${kind}.setPopup`]([details], ctx) {
        const target = actionTargetFromDetails(details);
        const url = details.popup && new URL(details.popup, ctx.url).href;
        if (url && !checkLoadURL(url)) throw new ExtensionError(`Access denied for URL ${url}`);
        const values = tb.actionData(kind, target);
        if (url === null) delete values.popup;
        else values.popup = url;
        return tb.actionRepaint(kind, target).then(() => null);
      },
      // :1018-1026 with getProperty (:900-902).
      [`${kind}.getPopup`]([details]) {
        return tb.actionData(kind, actionTargetFromDetails(details)).popup;
      },
      // :1064-1091 -> triggerAction(window, { requirePopupUrl: true }).
      [`${kind}.openPopup`]([options]) {
        const w = resolveWindow(options);
        return tb.triggerActionFromApi(kind, w.id);
      },
    });

    return {
      // ---- runtime
      "runtime.sendMessage"(args, ctx) {
        const a = [...args];
        if (a.length && a[a.length - 1] === null) a.pop();
        if (a.length !== 1) throw new FakeError("the fake models runtime.sendMessage(message) only");
        return tb.deliverRuntimeMessage(a[0], ctx);
      },

      // ---- storage.local (ExtensionStorageIDB.sys.mjs)
      "storage.local.get"([keys]) {
        let list;
        let defaults = {};
        if (keys === null || keys === undefined) list = [...tb.storage.keys()];
        else if (typeof keys === "string") list = [keys];
        else if (Array.isArray(keys)) list = keys;
        else {
          list = Object.keys(keys);
          defaults = keys;
        }
        const out = {};
        for (const k of list) {
          if (tb.storage.has(k)) out[k] = structuredClone(tb.storage.get(k));
          else if (k in defaults) out[k] = defaults[k];
        }
        return out;
      },
      "storage.local.set"([items]) {
        const changes = {};
        for (const k of Object.keys(items)) {
          const oldValue = tb.storage.get(k);
          tb.storage.set(k, structuredClone(items[k]));
          changes[k] = { oldValue: oldValue && structuredClone(oldValue), newValue: structuredClone(items[k]) };
        }
        if (Object.keys(changes).length) tb.storageChanged(changes);
      },
      "storage.local.remove"([keys]) {
        const changes = {};
        for (const k of [].concat(keys)) {
          if (tb.storage.has(k)) {
            changes[k] = { oldValue: tb.storage.get(k) };
            tb.storage.delete(k);
          }
        }
        if (Object.keys(changes).length) tb.storageChanged(changes);
      },

      // ---- menus (ext-menus.js)
      "menus.create"([props]) {
        // ext-menus.js:925-931 defaults; ExtensionMenus.sys.mjs:497-502 skips nulls.
        const item = { type: "normal", checked: false, contexts: ["all"], enabled: true, visible: true };
        for (const [k, v] of Object.entries(props)) if (v !== null) item[k] = v;
        if (item.id === undefined) item.id = tb.nextMenuItemId++;
        if (tb.menuItems.has(item.id)) {
          // ext-menus.js:1541-1545 rejects in the parent; the child call has returned already.
          tb.consoleMessages.push({ context: "menus", level: "error", args: [`The menu id ${item.id} already exists in menus.create.`] });
          return item.id;
        }
        tb.menuItems.set(item.id, item);
        return item.id;
      },
      "menus.update"([id, props]) {
        const item = tb.menuItems.get(id);
        if (!item) return; // ext-menus.js:1565-1568
        for (const [k, v] of Object.entries(props)) if (v !== null) item[k] = v;
      },
      "menus.refresh"() {
        tb.menuRefreshes++;
      },

      // ---- messages (ext-messages.js)
      "messages.get"([id]) {
        getMsg(id); // :1232-1236
        return tb.header(id);
      },
      "messages.update"([id, props]) {
        const m = getMsg(id); // :1638-1647
        if (m.external) throw new ExtensionError("Operation not permitted for external messages");
        if (props.read !== null) m.read = props.read;
        if (props.flagged !== null) m.flagged = props.flagged;
        if (Array.isArray(props.tags)) {
          // :1657-1690 only valid (existing) tag keys are applied.
          const isValidKey = (k) => !!tagByKey(k);
          const wanted = props.tags.filter(isValidKey);
          const current = m.keywords.filter(isValidKey);
          const stale = m.keywords.filter((k) => !isValidKey(k));
          m.keywords = [...stale, ...current.filter((k) => wanted.includes(k)), ...wanted.filter((k) => !current.includes(k))];
        }
        if (props.junk !== null) m.junk = props.junk;
      },
      "messages.tags.list"() {
        return tb.tags.map(({ key, tag, color, ordinal }) => ({ key, tag, color: color.toUpperCase(), ordinal })); // :2073-2081
      },
      "messages.tags.create"([key, tag, color]) {
        // :2098-2116
        if (tb.tags.find((t) => t.tag == tag)) throw new ExtensionError(`Specified tag already exists: ${tag}`);
        if (key != null) {
          key = lower(key);
          if (tagByKey(key)) throw new ExtensionError(`Specified key already exists: ${key}`);
        } else {
          key = lower(tag).replace(/[^a-z0-9]/g, "_"); // MODEL: auto-generated key
        }
        tb.tags.push({ key, tag, color, ordinal: "" });
        return key;
      },
      "messages.tags.update"([key, props]) {
        // :2117-2142
        key = lower(key);
        const tag = tagByKey(key);
        if (!tag) throw new ExtensionError(`Specified key does not exist: ${key}`);
        if (props.color) {
          const newColor = props.color.toUpperCase();
          if (newColor != tag.color.toUpperCase()) tag.color = newColor;
        }
        if (props.ordinal != null) tag.ordinal = props.ordinal;
        if (props.tag && tag.tag != props.tag) {
          if (tb.tags.find((t) => t.tag == props.tag)) throw new ExtensionError(`Specified tag already exists: ${props.tag}`);
          tag.tag = props.tag;
        }
      },

      // ---- messageDisplay (ext-messageDisplay.js:172-265)
      "messageDisplay.getDisplayedMessage"([tabId]) {
        let tab;
        if (tabId) {
          tab = tb.tabs.get(tabId);
          if (!tab) throw new ExtensionError(`Invalid tab ID: ${tabId}`);
        } else {
          tab = tb.activeTab(tb.topWindowId);
        }
        const displayed = () => {
          const ids = tb.displayedIds(tab);
          return ids.length === 1 ? tb.header(ids[0]) : null;
        };
        // getMessageDisplayTab waits until about:message has finished
        // displaying its message (ext-messageDisplay.js:205-231); a load that
        // never finishes keeps this call waiting.
        if (tb.displayedIds(tab).length === 1 && !tab.msgLoaded) {
          return new Promise((resolve) => tab.loadWaiters.push(() => resolve(displayed())));
        }
        return displayed();
      },

      // ---- tabs
      "tabs.query"([q], ctx) {
        const modelled = new Set(["active", "currentWindow", "lastFocusedWindow", "windowId", "type", "mailTab", "highlighted"]);
        for (const [k, v] of Object.entries(q)) {
          if (v !== null && !modelled.has(k)) throw new FakeError(`tabs.query filter ${k} is not modelled`);
        }
        // MODEL: the "current window" of a page in a window is that window; for
        // the background page it is the last focused window
        // (windowTracker.getCurrentWindow falls back to topWindow).
        const current = ctx.windowId ?? tb.topWindowId;
        return [...tb.tabs.values()]
          .filter((t) => q.active === null || t.active === q.active)
          .filter((t) => q.highlighted === null || t.active === q.highlighted)
          .filter((t) => q.currentWindow === null || (t.windowId === current) === q.currentWindow)
          .filter((t) => q.lastFocusedWindow === null || (t.windowId === tb.topWindowId) === q.lastFocusedWindow)
          .filter((t) => q.windowId === null || t.windowId === q.windowId)
          .filter((t) => q.mailTab === null || (t.type === "mail") === q.mailTab)
          .filter((t) => q.type === null || [].concat(q.type).includes(t.type))
          .map((t) => tb.tabInfo(t));
      },

      // ext-tabs.js:489-563. The window comes from getNormalWindowReady
      // (ext-mail.js:1653-1665: a given windowId must be a normal window, else
      // the most recent 3-pane window, :406-408); the URL is resolved against
      // the calling page (context.uri.resolve); the page opens as a content tab
      // that is selected unless active is false; nothing waits for focus.
      "tabs.create"([props], ctx) {
        let w;
        if (props.windowId) {
          w = props.windowId === -2 ? tb.windows.get(ctx.windowId ?? tb.topWindowId) : tb.windows.get(props.windowId);
          if (!w) throw new ExtensionError(`Invalid window ID: ${props.windowId}`);
          if (w.type !== "normal") throw new ExtensionError(`Window with ID ${props.windowId} is not a normal window`);
        } else {
          const top = tb.windows.get(tb.topWindowId);
          w = top?.type === "normal" ? top : tb.mainWindow; // MODEL: most recent 3-pane window
        }
        const url = props.url ? new URL(props.url, ctx.url).href : "about:blank";
        const opener = tb.activeTab(w.id);
        const active = props.active ?? true;
        const before = w.tabIds.map((id) => [id, tb.tabs.get(id).active]);
        const tab = tb.addTab(w.id, "content", { url, openerTabId: opener?.id ?? null });
        if (!active) {
          tab.active = false;
          for (const [id, wasActive] of before) tb.tabs.get(id).active = wasActive;
        }
        const record = { kind: "tab", windowId: w.id, tabId: tab.id, url, createProperties: props, loaded: false, dismissed: false, page: null };
        tb.popups.push(record);
        if (url.startsWith(BASE_URL) && tb.config.popupLoads) {
          setImmediate(() => {
            if (record.dismissed || !tb.tabs.has(tab.id)) return;
            record.page = tb.loadExtensionPage(url, {
              name: "editor tab",
              windowId: w.id,
              tab,
              // window.close() in a content tab closes the tab (specialTabs.js:517-530).
              // Not verified: Gecko's own permission check for script-initiated
              // closes of a tab the script did not open (greprefs.js:334 sets
              // dom.allow_scripts_to_close_windows to false).
              onClose: () => tb.closeTabPage(record),
            });
            record.loaded = true;
          });
        }
        return tb.tabInfo(tab);
      },

      // ---- mailTabs (ext-mailTabs.js:239-256 getTabOrActive, :633-638)
      // The actual selection, collapsed threads expanded, context-clicked but
      // unselected rows left out (ExtensionMailTabs.sys.mjs:18-31, :43-66).
      "mailTabs.getSelectedMessages"([tabId]) {
        let tab;
        if (tabId) {
          tab = tb.tabs.get(tabId);
          if (!tab) throw new ExtensionError(`Invalid tab ID: ${tabId}`); // ext-mail.js:564
        } else {
          tab = tb.activeTab(tb.topWindowId); // ext-mail.js:806-810
          tabId = tab?.id;
        }
        if (!tab || tab.type !== "mail") throw new ExtensionError(`Invalid mail tab ID: ${tabId}`);
        return tb.messageList(tab.selected);
      },

      // ---- windows (ext-windows.js:364-570)
      "windows.create"([createData]) {
        const data = createData || {};
        const w = tb.addWindow(data.type === null || data.type == "normal" ? "normal" : "popup");
        const url = Array.isArray(data.url) ? data.url[0] : data.url || "about:blank";
        const tab = tb.addTab(w.id, "content", { url });
        const record = { kind: "window", windowId: w.id, url, createData: data, loaded: false, page: null };
        tb.popups.push(record);
        if (url.startsWith(BASE_URL) && tb.config.popupLoads) {
          setImmediate(() => {
            record.page = tb.loadExtensionPage(url, { name: "popup window", windowId: w.id, tab });
            record.loaded = true;
          });
        }
        if (!tb.config.windowFocusArrives) {
          // ext-windows.js:533-544: create() awaits the new window's focus event.
          return new Promise(() => {});
        }
        tb.topWindowId = w.id;
        return tb.windowInfo(w);
      },

      // ---- actions (ExtensionToolbarButtons.sys.mjs getAPI, :937-1091)
      ...actionApi("browserAction"),
      ...actionApi("messageDisplayAction"),

      // ---- messageDisplayScripts (ext-extensionScripts.js)
      "messageDisplayScripts.register"([options]) {
        const reg = { ...options };
        tb.displayScripts.push(reg);
        return {
          unregister: async () => {
            tb.displayScripts = tb.displayScripts.filter((r) => r !== reg);
          },
        };
      },
    };
  }

  // -------------------------------------------------------------- helpers --

  apiCalls(api) {
    return this.calls.filter((c) => c.api === api);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.frameWaiters = [];
    this.clock.dispose();
    for (const p of this.popups) p.page?.destroy();
    for (const p of this.displayPages) p.dom.window.close();
    this.releaseRejections();
  }
}

module.exports = { FakeThunderbird, FakeClock, thunderbirdSchemas, readManifest, readSource, flush, SRC, BASE_URL, ExtensionError, FakeError, ERROR_NO_RECEIVERS };
