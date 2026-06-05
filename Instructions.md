# Instructions - Context-Aware Paragraph Notes

This plugin adds an Obsidian sidebar panel for notes linked to the paragraph where your cursor is located.

When the cursor is inside a paragraph, the sidebar shows the notes for that paragraph. When you move to another paragraph, the sidebar updates and shows that paragraph's notes.

## Installation

1. Open your Obsidian vault folder.
2. Go to:

```text
.obsidian/plugins
```

3. Create a folder named:

```text
context-aware-paragraph-notes
```

4. Copy these files into it:

```text
main.js
manifest.json
styles.css
```

5. In Obsidian, open:

```text
Settings -> Community plugins
```

6. Make sure Community plugins are enabled.
7. Enable `Context-Aware Paragraph Notes`.

After updating plugin files, disable and re-enable the plugin, or reload Obsidian.

## Opening The Sidebar

You can open the notes sidebar from:

- The plugin ribbon icon
- The Command Palette command:

```text
Open paragraph notes sidebar
```

## Basic Use

1. Open a Markdown file in Obsidian.
2. Place the cursor inside a paragraph.
3. Open the notes sidebar.
4. Write a note in the input area.
5. Click `Add note`.

The note is saved and linked to the paragraph where the cursor was located.

After the note is added, the new-note input area is cleared automatically.

## Where Notes Are Saved

Notes are saved inside the vault, not only in the plugin's internal data.

The data file is:

```text
_SideNotes/side-notes-data.json
```

This means the notes remain in the vault even if the plugin folder is accidentally deleted. The plugin settings are still stored in Obsidian's plugin data, but the notes themselves are stored in `_SideNotes`.

Each file also gets a stable internal `SideNotesID`. Notes are stored under that ID, while the plugin keeps a path-to-`SideNotesID` map. This prevents conflicts between files with the same name in different folders and helps keep notes attached when a file is renamed or moved.

The `SideNotesID` is not shown in the sidebar UI. If the `SideNotesID` field or its path map is accidentally removed from the data file, the plugin tries to restore it from the stored file record. If the entire stored file record is deleted manually, the plugin cannot recover those notes without a backup.

The plugin can also store `SideNotesID` in the Markdown file properties. When this setting is enabled, the plugin adds a `SideNotesID` property and restores it if it is removed or changed during normal Obsidian editing. This is not a true operating-system-level lock, but it gives the ID a self-healing backup inside the note.

New `SideNotesID` values use the `SideNotesID-` prefix. Older values that start with `SideNoteID-` are normalized to `SideNotesID-` while keeping the same random ID suffix.

## Note Display

Each note is collapsed by default.

When collapsed, the note shows its first line so you can quickly scan your notes. Long first lines wrap naturally to the panel width.

When a note is opened, the collapsed first-line summary disappears and only the full note preview is shown.

Each note has icon buttons:

- Down arrow - open note
- Up arrow - close note
- Pencil - edit note
- Trash - delete note
- Disk - save edit
- X - cancel edit

Each note card also has a checkbox. Select one or more notes, click the scissors button to cut them, move to another paragraph, and click the paste button to move the notes there.

Select-all buttons are available for the current view, and in all-file/all-vault/orphaned views also for each file and paragraph group. In the main toolbar, the select-all button is shown when nothing is selected. When notes are selected, a separate selection-action group appears. Its creation order is reversed so RTL toolbars can show clear-selection, cut-selected, and delete-selected in that visual order.

When notes are selected, the toolbar also shows a trash button for deleting the selected notes in one action.

While editing an existing note, the cancel button appears on the right side, and the save button appears on the left side.

The top of the sidebar includes a view dropdown for choosing:

- Current paragraph notes
- All notes in the current file
- Orphaned notes
- All notes in the vault, when enabled in settings

It also includes general icon buttons for:

- Opening all notes for the current paragraph
- Closing all notes for the current paragraph
- Hiding or showing the new-note input area

This lets you use the sidebar as a clean reading panel without the new-note editor taking space.

The sidebar header also shows the current mode explicitly:

- `Current paragraph`
- `All notes in file`
- `All notes in vault`
- `Orphaned notes`

In Current paragraph mode and All notes in file mode, the export button creates a new Markdown file and opens it automatically.

The setting `Blank line between exported notes` controls whether notes that belong to the same paragraph are separated by an empty line in the exported Markdown file. It is enabled by default.

The exported file name starts with:

```text
SideNotes (SideNotesID) (FileName)
```

## Transfer Files With SideNotes

Right-click one or more Markdown files in Obsidian's file explorer and choose `Export with SideNotes` or `Export selected files with SideNotes`. This menu item appears only for Markdown files that already have a `SideNotesID` property.

The plugin creates a `.sidenotes` transfer file. This file contains:

- The Markdown file content
- The original file path and name
- The file `SideNotesID`
- All saved side notes, anchors, fingerprints, and line metadata for that file
- Linked non-Markdown vault attachments, such as images, PDFs, and other embedded files

When possible, Obsidian opens a Save As dialog so you can choose the file name and location, such as the desktop. The Save As dialog uses the `sidenotes` file type, suggests a file name without the extension, and leaves `All files` available as a fallback. If the Save As dialog is not available in the current Obsidian/Chromium environment, the plugin saves the `.sidenotes` file inside the vault instead.

To import on another computer, open the plugin settings and click `Import` under `Import .sidenotes file`.

Import creates regular Markdown files in the vault and writes their side notes into `_SideNotes/side-notes-data.json`. If a file with the same path already exists, the plugin does not overwrite it. It creates a free filename such as `File imported.md`, and connects the imported notes to that new file.

If the imported `SideNotesID` already exists in the vault or in the side-notes data, the plugin gives the imported file a new unused `SideNotesID`. This prevents two Markdown files from sharing the same side-note identity.

Imported attachments are restored to their original vault paths so the Markdown links keep working. If an attachment already exists at that path, the plugin leaves the existing file in place and does not overwrite it.

## All Notes In The Current File

The sidebar can switch between two modes:

- Current paragraph notes
- All notes in the current file
- Orphaned notes

In all-file mode, the sidebar shows every note saved for the current file, grouped by Block ID. This is useful if a paragraph was edited, moved, or temporarily lost its Block ID connection.

Each group shows:

- The Block ID
- The saved paragraph fingerprint, when available
- The notes attached to that Block ID

You can still open, close, edit, and delete notes in this mode.

## Orphaned Notes

If a Markdown file is deleted, its side notes are not deleted automatically. They remain in `_SideNotes/side-notes-data.json`.

The sidebar includes an orphaned-notes mode. It shows notes whose saved file path no longer exists in the vault.

For each orphaned file, the sidebar shows:

- The old file name
- The old file path
- The `SideNotesID`
- The Block ID groups and their notes

You can still open, close, edit, and delete orphaned notes. The plugin does not delete them automatically, to avoid silent data loss.

## Markdown Editing

Notes support basic Markdown.

The small toolbar above the editor helps insert:

- Bullet lists
- Numbered lists
- Checkboxes
- Bold text
- Italic text
- Inline code
- Obsidian internal links

You can also write Markdown manually:

```md
- First point
- Second point
- [ ] Check later

**Important:** return to this paragraph.

Link to another note: [[Note name]]
```

## Text Direction And RTL

The plugin settings include `Note text direction`.

Options:

- `Auto` - automatic direction based on the text
- `Right to left` - useful for Hebrew
- `Left to right` - useful for English

If `Auto` does not feel right for a specific case, choose `Right to left` when most notes are in Hebrew.

## Font And Size

The plugin settings include `Note font` and `Note font size`.

They change the font family and text size in:

- The new-note editor
- Existing note editing
- The first-line collapsed note summary

The new-note and edit text boxes grow automatically to fit their text while still allowing manual vertical resizing from the corner.
- The expanded note preview

The slider supports sizes up to `56px`.

## Paragraph Anchors

By default, the plugin links notes to paragraphs with internal anchors stored in:

```text
_SideNotes/side-notes-data.json
```

In this default mode, the plugin does not add a hidden `^side-note...` value to the Markdown text. This keeps normal typing, spaces, Enter, Delete, and Backspace behavior under Obsidian's editor instead of the plugin trying to protect hidden text.

The plugin stores a fingerprint of the paragraph text and the paragraph's last known line range. This lets it reconnect notes to the paragraph without writing an anchor into the document.

For compatibility, the plugin can still read existing Obsidian Block IDs that are already in a note:

```md
This is an example paragraph. ^side-note-a1b2c3
```

If you intentionally want native Obsidian Block IDs written into Markdown, set `Paragraph anchor storage` to `Markdown Block IDs` in the plugin settings. In that mode, the older Block ID insertion and protection options apply.

`SideNotesID` is the stable ID for an entire file. A Block ID or internal anchor is the ID for a paragraph inside that file.

Important:

- Internal anchors are cleaner for editing because they are not part of the Markdown text.
- If paragraph text is changed completely and moved far away, the plugin may not be able to reconnect it without an existing fingerprint or last known location.
- Native Obsidian Block IDs remain useful if you need Obsidian's own block-linking behavior outside this plugin.

## Plugin Settings

`Paragraph anchor storage`

Controls whether new paragraph anchors are stored internally in plugin data or written into Markdown as native Obsidian Block IDs.

`Automatically add block IDs`

Only applies when `Paragraph anchor storage` is set to `Markdown Block IDs`. Controls whether the plugin automatically adds or restores a Block ID for paragraphs without one.

`Hide plugin block IDs in editor`

Visually hides generated plugin Block IDs in the Markdown editor. In internal-anchor mode, this hides old `^side-note-...` values that already exist in Markdown. In Markdown Block ID mode, it also protects generated Block IDs from accidental edits. Reload Obsidian after changing this setting.

`Confirm before deleting notes`

Controls whether the plugin asks for confirmation before deleting a note.

`Open notes by default`

Controls whether notes are open or collapsed by default when displayed in the sidebar.

`Blank line between exported notes`

Controls whether exported Markdown includes an empty line between notes that belong to the same paragraph. Enabled by default.

`Store SideNotesID in file properties`

Adds a `SideNotesID` property to Markdown files and restores it if it is removed or changed.

`Block ID prefix`

The prefix for new generated Block IDs. Default:

```text
side-note
```

`Note font size`

The font size for notes in the sidebar.

`Note font`

The font family for note editors and note previews. The dropdown tries to load installed fonts from Obsidian/Chromium and includes fallback fonts if the installed font list is not available.

`Note text direction`

The writing direction for notes: automatic, right to left, or left to right.

`Update on selection changes`

Controls whether the sidebar updates when the editor selection changes.

`Update debounce`

A short delay, in milliseconds, before updating the sidebar. Usually this does not need to be changed.

## Useful Notes

- When you click inside the sidebar to write, the plugin should remember the last paragraph you were on.
- If the sidebar says no paragraph is selected, click inside a paragraph in a Markdown file again.
- After changing plugin files, reload or restart the plugin in Obsidian.
- If a Block ID is deleted manually, the plugin will try to recover the connection using the paragraph fingerprint.

## Important Project Files

```text
main.ts        Plugin source code
main.js        The file Obsidian loads
manifest.json  Plugin metadata
styles.css     Sidebar styling
package.json   Development and build settings
```

## Rebuilding

If you change `main.ts`, run:

```text
npm run build
```

Then reload the plugin in Obsidian.

---

# הוראות שימוש - Context-Aware Paragraph Notes

הפלאגין מוסיף לאובסידיאן פאנל צד להערות שמחוברות לפסקה שבה נמצא הסמן.

כאשר הסמן נמצא בפסקה מסוימת, הפאנל מציג את ההערות של אותה פסקה. כאשר עוברים לפסקה אחרת, הפאנל מתעדכן ומציג את ההערות שלה.

## התקנה באובסידיאן

1. פתח את תיקיית הכספת שלך באובסידיאן.
2. היכנס לתיקייה:

```text
.obsidian/plugins
```

3. צור שם תיקייה:

```text
context-aware-paragraph-notes
```

4. העתק לתוכה את הקבצים האלה מתוך תיקיית הפרויקט:

```text
main.js
manifest.json
styles.css
```

5. באובסידיאן, פתח:

```text
Settings -> Community plugins
```

6. ודא ש־Community plugins פעילים.
7. מצא את `Context-Aware Paragraph Notes` והפעל אותו.

אחרי עדכון קבצים כדאי לכבות ולהפעיל מחדש את הפלאגין, או לעשות Reload לאובסידיאן.

## פתיחת פאנל ההערות

אפשר לפתוח את הפאנל דרך:

- האייקון של הפלאגין בסרגל הצד
- Command Palette עם הפקודה:

```text
Open paragraph notes sidebar
```

## שימוש בסיסי

1. פתח קובץ Markdown באובסידיאן.
2. שים את הסמן בתוך פסקה.
3. פתח את פאנל ההערות.
4. כתוב הערה בשדה הכתיבה.
5. לחץ על `Add note`.

ההערה תישמר ותהיה מחוברת לפסקה שבה הסמן היה בזמן יצירת ההערה.

אחרי הוספת ההערה, שדה הכתיבה מתנקה אוטומטית.

## איפה ההערות נשמרות

ההערות נשמרות בתוך הכספת, ולא רק בנתונים הפנימיים של הפלאגין.

קובץ הנתונים הוא:

```text
_SideNotes/side-notes-data.json
```

כך ההערות נשארות בתוך הכספת גם אם תיקיית הפלאגין נמחקת בטעות. הגדרות הפלאגין עדיין נשמרות בנתוני הפלאגין של Obsidian, אבל ההערות עצמן נשמרות בתיקיית `_SideNotes`.

בנוסף, כל קובץ מקבל מזהה פנימי קבוע בשם `SideNotesID`. ההערות נשמרות תחת המזהה הזה, והפלאגין שומר מיפוי בין הנתיב של הקובץ לבין ה־`SideNotesID`. כך אין התנגשות בין שני קבצים עם אותו שם בתיקיות שונות, וההערות נשארות מחוברות טוב יותר גם אם משנים שם לקובץ או מעבירים אותו תיקייה.

ה־`SideNotesID` לא מוצג בממשק של פאנל הצד. אם השדה `SideNotesID` או המיפוי שלו נמחקים בטעות מקובץ הנתונים, הפלאגין מנסה לשחזר אותם מתוך רשומת הקובץ השמורה. אם מוחקים ידנית את כל רשומת הקובץ מתוך קובץ הנתונים, הפלאגין לא יכול לשחזר את ההערות בלי גיבוי.

הפלאגין יכול לשמור את ה־`SideNotesID` גם ב־Properties של קובץ ה־Markdown. כאשר ההגדרה פעילה, הפלאגין מוסיף מאפיין `SideNotesID` ומשחזר אותו אם הוא נמחק או שונה במהלך עריכה רגילה באובסידיאן. זו לא נעילה אמיתית ברמת מערכת ההפעלה, אבל זו שכבת גיבוי שמשחזרת את המזהה מתוך ההערה עצמה.

## תצוגת הערות

כל הערה מוצגת במצב סגור כברירת מחדל.

במצב סגור רואים את השורה הראשונה של ההערה, כך שאפשר לסרוק מהר את כל ההערות. שורה ארוכה יורדת שורות לפי רוחב הפאנל.

כאשר פותחים הערה, שורת הסיכום נעלמת ורואים רק את התצוגה המלאה של ההערה.

לכל הערה יש כפתורי אייקונים:

- חץ למטה - פתיחת ההערה
- חץ למעלה - סגירת ההערה
- עיפרון - עריכת ההערה
- פח - מחיקת ההערה
- דיסקט - שמירת עריכה
- איקס - ביטול עריכה

בזמן עריכת הערה קיימת, כפתור הביטול נמצא בצד ימין, וכפתור השמירה נמצא בצד שמאל.

בחלק העליון של הפאנל יש כפתורי אייקונים כלליים:

- מעבר בין הערות של הפסקה הנוכחית לבין כל ההערות בקובץ הנוכחי
- פתיחת כל ההערות של הפסקה הנוכחית
- סגירת כל ההערות של הפסקה הנוכחית
- הסתרה או הצגה של אזור הוספת הערה חדשה

כך אפשר להשתמש בפאנל גם רק כמצב צפייה, בלי ששדה הכתיבה יתפוס מקום.

כותרת הפאנל מציגה גם את המצב הנוכחי בצורה מפורשת:

- `Mode: Current paragraph`
- `Mode: All notes in file`
- `Mode: Orphaned notes`

במצב הערות של הפסקה הנוכחית ובמצב כל ההערות בקובץ, כפתור הייצוא יוצר קובץ Markdown חדש ופותח אותו אוטומטית.

שם קובץ הייצוא מתחיל כך:

```text
SideNotes (SideNotesID) (FileName)
```

## כל ההערות בקובץ הנוכחי

אפשר לעבור בפאנל בין שלושה מצבים:

- הערות של הפסקה הנוכחית
- כל ההערות בקובץ הנוכחי
- הערות יתומות

במצב כללי לפי קובץ, הפאנל מציג את כל ההערות שנשמרו עבור הקובץ הנוכחי, מקובצות לפי Block ID. זה שימושי אם פסקה נערכה, זזה, או איבדה זמנית את החיבור ל־Block ID.

בכל קבוצה מוצגים:

- ה־Block ID
- טביעת האצבע של הפסקה, אם קיימת
- ההערות שמחוברות לאותו Block ID

גם במצב הזה אפשר לפתוח, לסגור, לערוך ולמחוק הערות.

## הערות יתומות

אם מוחקים קובץ Markdown, ההערות שלו לא נמחקות אוטומטית. הן נשארות בתוך `_SideNotes/side-notes-data.json`.

בפאנל יש מצב של הערות יתומות. הוא מציג הערות שהנתיב השמור של הקובץ שלהן כבר לא קיים בכספת.

לכל קובץ יתום מוצגים:

- שם הקובץ הישן
- הנתיב הישן
- ה־`SideNotesID`
- קבוצות ה־Block ID וההערות שלהן

גם במצב הזה אפשר לפתוח, לסגור, לערוך ולמחוק הערות. הפלאגין לא מוחק אותן אוטומטית כדי למנוע אובדן מידע שקט.

## עריכת Markdown

אפשר לכתוב בהערות Markdown בסיסי.

הכפתורים הקטנים מעל שדה הכתיבה עוזרים להוסיף:

- רשימת bullets
- רשימה ממוספרת
- checkbox
- טקסט מודגש
- טקסט נטוי
- קוד בתוך שורה
- קישור פנימי של אובסידיאן

אפשר גם לכתוב Markdown ידנית:

```md
- נקודה ראשונה
- נקודה שנייה
- [ ] לבדוק אחר כך

**חשוב:** לחזור לפסקה הזאת.

קישור להערה אחרת: [[שם הערה]]
```

## כיוון כתיבה ו־RTL

בהגדרות הפלאגין יש אפשרות `Note text direction`.

האפשרויות הן:

- `Auto` - כיוון אוטומטי לפי הטקסט עצמו
- `Right to left` - מתאים לעברית
- `Left to right` - מתאים לאנגלית

אם `Auto` לא מרגיש מספיק טוב במקרה מסוים, מומלץ לבחור `Right to left` כאשר רוב ההערות בעברית.

## גודל פונט

בהגדרות הפלאגין יש אפשרות `Note font size`.

היא משנה את גודל הטקסט בשדה הכתיבה, בעריכת הערה קיימת, בשורה הראשונה של הערה סגורה, ובתצוגת ההערה הפתוחה.

הסליידר תומך עכשיו עד `56px`.

## Block IDs והגנה ממחיקה

כדי לחבר הערה לפסקה בצורה יציבה, הפלאגין משתמש ב־Block ID של אובסידיאן.

אם לפסקה אין עדיין Block ID, הפלאגין יכול להוסיף לה אוטומטית מזהה בסוף הפסקה:

```md
זו פסקה לדוגמה. ^side-note-a1b2c3
```

ההערות עצמן לא נשמרות בתוך קובץ ה־Markdown. הן נשמרות בנתוני הפלאגין.

בנוסף ל־Block ID, הפלאגין שומר גם טביעת אצבע של תוכן הפסקה. אם המשתמש מוחק בטעות את ה־Block ID, הפלאגין יכול לזהות את הפסקה לפי הטקסט שלה ולהציג את ההערות הישנות.

כאשר מוסיפים הערה חדשה או עורכים הערה קיימת לפסקה שה־Block ID שלה נמחק, הפלאגין ישחזר את אותו Block ID לקובץ, כל עוד האפשרות `Automatically add block IDs` פעילה.

חשוב לדעת:

- אי אפשר לחסום לחלוטין מחיקה של טקסט בתוך עורך Markdown רגיל של Obsidian.
- אי אפשר להסתיר לגמרי Block ID ועדיין להשתמש בו כ־Block ID טבעי של Obsidian.
- אפשר להפחית טעויות בעזרת השחזור האוטומטי שמתואר כאן.
- אם משנים את תוכן הפסקה לגמרי וגם מוחקים את ה־Block ID, ייתכן שהפלאגין לא יצליח לזהות אותה מחדש.

## הגדרות הפלאגין

`Automatically add block IDs`

קובע האם הפלאגין יוסיף או ישחזר Block ID אוטומטית לפסקה שאין לה מזהה.

`Hide plugin block IDs in editor`

מסתיר חזותית את ה־Block IDs שהפלאגין יוצר בתוך עורך ה־Markdown, גורם לעורך להתייחס אליהם כטווח אטומי שהסמן מדלג מעליו, וגם חוסם עריכות רגילות שנוגעות במזהים האלה. ה־Block ID עדיין קיים בקובץ, אבל מוסתר בתצוגת העריכה. אחרי שינוי ההגדרה צריך לעשות Reload לאובסידיאן.

`Confirm before deleting notes`

קובע האם הפלאגין יבקש אישור לפני מחיקת הערה.

`Open notes by default`

קובע האם הערות יוצגו פתוחות או סגורות כברירת מחדל בפאנל הצד.

`Store SideNotesID in file properties`

מוסיף מאפיין `SideNotesID` לקובצי Markdown ומשחזר אותו אם הוא נמחק או שונה.

`Block ID prefix`

הקידומת של מזהים חדשים. ברירת המחדל היא:

```text
side-note
```

`Note font size`

גודל הפונט של ההערות בפאנל הצד.

`Note text direction`

כיוון הכתיבה של ההערות: אוטומטי, ימין לשמאל, או שמאל לימין.

`Update on selection changes`

קובע האם הפאנל יתעדכן גם כאשר הבחירה בעורך משתנה.

`Update debounce`

השהיה קצרה במילישניות לפני עדכון הפאנל. בדרך כלל אין צורך לשנות.

## דברים שכדאי לדעת

- אם אתה לוחץ בתוך פאנל ההערות כדי לכתוב, הפלאגין אמור לזכור את הפסקה האחרונה שהיית עליה.
- אם הפאנל מציג שאין פסקה נבחרת, לחץ שוב בתוך פסקה בקובץ Markdown.
- אם שינית קבצי פלאגין, צריך להפעיל מחדש את הפלאגין כדי לראות את השינוי.
- אם מחקת ידנית את ה־Block ID מתוך הפסקה, החיבור ינסה להשתחזר לפי טביעת האצבע של הפסקה.

## קבצים חשובים בפרויקט

```text
main.ts        קוד המקור של הפלאגין
main.js        הקובץ שאובסידיאן טוען בפועל
manifest.json  פרטי הפלאגין
styles.css     עיצוב פאנל הצד
package.json   הגדרות פיתוח ובנייה
```

## בנייה מחדש

אם משנים את `main.ts`, צריך להריץ בנייה מחדש:

```text
npm run build
```

לאחר מכן יש לטעון מחדש את הפלאגין באובסידיאן.
