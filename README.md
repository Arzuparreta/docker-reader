# Docker Reader
Book library in docker. Import books, read it in any browser. Resume the reading of any book in any device. Multi user support.


![ui](/docs/ui-v0.9.0.png)
![ui-dark](/docs/ui-dark-v0.9.0.png)

## How to use

`docker compose up`, open <http://localhost:3433>.

`data/config.json`: users, session secret, and
`"addr": ":3433"` so the process matches the mapped port.

Sign in, upload PDFs from the app, read. Your place in each book is tied to that
user.

## Keyboard shortcuts

### Palettes and global

| Shortcut | Action |
| --- | --- |
| Ctrl+Space | Open or close the command palette (requires sign-in) |
| Ctrl+K or ⌘+K | Open theme picker |
| Shift+G | Go to page |
| Shift+O | Open book switcher (reader; sign-in and book open) |
| Shift+N | Open notes (reader; book open) |
| Backslash | Toggle both side rails |
| Esc | Close the notes editor when it is open |

### Reader (book open)

| Shortcut | Action |
| --- | --- |
| ← or → | Previous or next page |
| H or L | Previous or next page |
| ↑ or ↓ | Scroll vertically (when the page scrolls) |
| J or K | Scroll vertically (when the page scrolls) |
| Shift+J or Shift+K | Zoom out or zoom in |
| / or Ctrl+L | Focus the page number field |
