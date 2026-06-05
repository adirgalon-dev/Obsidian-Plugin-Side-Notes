# SideNotes

SideNotes is an Obsidian plugin for writing sidebar notes that stay connected to the paragraph you are reading or editing.

Instead of keeping comments in a separate file, SideNotes lets you attach small notes to the exact paragraph that matters. Move through your document, and the sidebar follows your cursor, showing only the notes that belong to the current paragraph. You can also switch to a file-wide view to review every note saved for the current file.

## Features

- Add notes to the paragraph under your cursor
- View notes for the current paragraph, the current file, orphaned files, or the whole vault
- Keep notes in a sidebar, separate from the Markdown text
- Collapse and expand notes for cleaner reading
- Edit, delete, cut, paste, and bulk-select notes
- Use Markdown inside notes
- Choose note direction: automatic, right-to-left, or left-to-right
- Choose note font and note font size
- Store a stable `SideNotesID` in file properties
- Recover note connections using paragraph fingerprints and stored anchors
- Export Markdown files together with their SideNotes
- Import `.sidenotes` transfer files into another vault
- Include linked vault attachments, such as images and PDFs, in transfer files

## Transfer Files With SideNotes

SideNotes can export a Markdown file together with its saved notes into a `.sidenotes` transfer file.

The transfer file includes the Markdown content, the file identity, the saved paragraph notes, paragraph anchors, fingerprints, line metadata, and linked non-Markdown vault attachments. This is useful when you want to move a note to another computer or another vault while keeping its SideNotes attached.

When importing, SideNotes avoids overwriting existing Markdown files. If a file already exists, the imported file gets a free name such as `File imported.md`. If the imported `SideNotesID` is already used in the target vault, the imported file receives a new unused `SideNotesID`, so two files do not share the same note identity.

## How Notes Are Stored

SideNotes stores note data inside the vault:

```text
_SideNotes/side-notes-data.json
```

Each Markdown file can also receive a `SideNotesID` property. This ID is used as the stable identity of the file, so notes can stay connected even when file paths change.

The plugin does not store your notes on an external server. Everything stays inside your Obsidian vault.

## Installation

### Manual Install

Download or build the plugin files, then copy these files into:

```text
.obsidian/plugins/context-aware-paragraph-notes
```

Required files:

```text
main.js
manifest.json
styles.css
```

Then open Obsidian, go to `Settings -> Community plugins`, enable community plugins if needed, and enable `SideNotes`.

### Build From Source

Clone this repository, install dependencies, and build:

```bash
npm install
npm run build
```

The generated `main.js` file is the file Obsidian loads.

## Privacy And Safety

Do not publish your personal vault data with the plugin source.

Files such as `_SideNotes/side-notes-data.json`, `.sidenotes` exports, `.obsidian`, and local plugin `data.json` may contain private information and should stay out of public repositories.

## Status

This plugin is in active development. It is already usable, but please keep backups of important vaults when testing new versions.

## License

MIT
