# tNOTE

A small Thunderbird extension: right-click a message, choose **Add note…**, and the note shows as a green bar at the top of that message when you open it. Messages with a note get a green **Note** tag (named **tNOTE** if you already have a tag called Note). Uses only Thunderbird's stable WebExtension APIs, so it should survive Thunderbird updates.

The message header's **Note** button opens the note for the message you are reading. The main toolbar's **Note** button (top right) shows **All notes**, newest first, with search; clicking one jumps to its message. The editor is a drop-down panel, so it always appears in front. It saves as you type; **Done**, Escape or Ctrl+Enter close it, and **Delete note** removes the note and tag. If no panel can open, the editor opens in a tab.

Download `tnote.xpi` from [Releases](https://github.com/wadejbeckett/tnote/releases) or build it with `./build.sh`, then in Thunderbird go to Add-ons and Themes, gear menu, **Install Add-on From File**, and pick `tnote.xpi`. Licensed GPLv3.

Notes are stored in the extension's local storage, keyed by Message-ID, and are not synced between computers. Copies of a message (same Message-ID) share one note. Removing the extension deletes the notes. Notes are hidden when printing.

Thunderbird gives add-ons no hook to run code when they are uninstalled, so the **Note** tag stays in Thunderbird's tag list afterwards. Remove it in Settings, General, Tags.

## Tests

`cd tests && npm install && npm test`. The suite fakes Thunderbird's add-on API and validates every call against the real schemas read from the installed Thunderbird (`/usr/lib/thunderbird/omni.ja`, override with `TB_OMNI`), so a call Thunderbird would reject fails the test. jsdom is the only dependency.
