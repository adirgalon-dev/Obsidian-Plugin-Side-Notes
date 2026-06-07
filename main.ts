import {
  App,
  ButtonComponent,
  debounce,
  DropdownComponent,
  Editor,
  ItemView,
  Menu,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  TAbstractFile,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import { EditorState, RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const VIEW_TYPE_SIDE_NOTES = "context-aware-paragraph-notes-view";
const BLOCK_ID_PATTERN = /(?:^|\s)\^([A-Za-z0-9_-]+)\s*$/;
const SIDE_NOTES_FOLDER = "_SideNotes";
const SIDE_NOTES_DATA_PATH = `${SIDE_NOTES_FOLDER}/side-notes-data.json`;
const SIDE_NOTES_ID_PROPERTY = "SideNotesID";
const LEGACY_SIDE_NOTE_ID_PROPERTY = "SideNoteID";
const SIDE_NOTES_ID_PREFIX = "SideNotesID";
const LEGACY_SIDE_NOTE_ID_PREFIX = "SideNoteID";
const SIDE_NOTES_BUNDLE_TYPE = "side-notes-transfer-bundle";
const SIDE_NOTES_BUNDLE_VERSION = 1;
const SIDE_NOTES_BUNDLE_MIME_TYPE = "application/x-sidenotes";

interface SideNote {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface BlockNotes {
  notes: SideNote[];
  fingerprint?: string;
  fromLine?: number;
  toLine?: number;
}

interface SideNotesData {
  files: Record<string, Record<string, BlockNotes>>;
  sideNoteIds: Record<string, string>;
  filesBySideNoteId: Record<string, StoredFileNotes>;
  fileIds?: Record<string, string>;
  filesById?: Record<string, StoredFileNotes>;
}

interface StoredFileNotes {
  SideNoteID: string;
  id?: string;
  path: string;
  name: string;
  blocks: Record<string, BlockNotes>;
}

interface SideNotesSettings {
  anchorStorage: "internal" | "block-id";
  autoInsertBlockIds: boolean;
  blockIdPrefix: string;
  confirmBeforeDelete: boolean;
  defaultNotesExpanded: boolean;
  exportBlankLineBetweenNotes: boolean;
  hidePluginBlockIds: boolean;
  noteFontFamily: string;
  noteFontSizePx: number;
  noteEditorFontSizePx: number;
  notePreviewFontSizePx: number;
  buttonSizePx: number;
  noteDirection: "auto" | "rtl" | "ltr";
  showAllVaultNotesButton: boolean;
  storeSideNoteIDInProperties: boolean;
  updateOnSelectionChange: boolean;
  updateDebounceMs: number;
}

interface ParagraphContext {
  file: TFile;
  filePath: string;
  fileName: string;
  fromLine: number;
  toLine: number;
  text: string;
  fingerprint: string;
  hasBlockIdInFile: boolean;
  blockId: string | null;
}

interface FileNoteGroup {
  blockId: string;
  notes: SideNote[];
  fingerprint?: string;
}

interface CurrentFileInfo {
  path: string;
  name: string;
}

interface OrphanedFileNotes {
  SideNoteID: string;
  path: string;
  name: string;
  groups: FileNoteGroup[];
  exists?: boolean;
}

interface StoredFileNoteSummary {
  SideNoteID: string;
  path: string;
  name: string;
  groups: FileNoteGroup[];
  orphaned: boolean;
}

type ViewMode = "paragraph" | "file" | "orphaned" | "vault";

interface RenderOptions {
  preserveScroll?: boolean;
}

interface SideNotesScrollState {
  contentTop: number;
  listTop: number;
}

interface SideNoteReference {
  sourcePath: string;
  sourceSideNoteId?: string;
  blockId: string;
  noteId: string;
}

interface SideNotesTransferBundle {
  type: typeof SIDE_NOTES_BUNDLE_TYPE;
  version: typeof SIDE_NOTES_BUNDLE_VERSION;
  exportedAt: number;
  files: SideNotesTransferFile[];
}

interface SideNotesTransferFile {
  path: string;
  name: string;
  basename: string;
  content: string;
  SideNotesID: string;
  blocks: Record<string, BlockNotes>;
  attachments: SideNotesTransferAttachment[];
}

interface SideNotesTransferAttachment {
  path: string;
  name: string;
  data: string;
}

interface SideNotesImportResult {
  fileCount: number;
  noteCount: number;
  attachmentCount: number;
}

interface SideNotesSaveFileHandle {
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface LocalFontData {
  family: string;
}

const DEFAULT_NOTE_FONT_LABEL = "Obsidian default";
const FALLBACK_NOTE_FONT_FAMILIES = [
  "Arial",
  "Calibri",
  "Cambria",
  "Consolas",
  "Courier New",
  "David",
  "Georgia",
  "Miriam",
  "Narkisim",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Verdana"
];

const DEFAULT_SETTINGS: SideNotesSettings = {
  anchorStorage: "internal",
  autoInsertBlockIds: true,
  blockIdPrefix: "side-note",
  confirmBeforeDelete: true,
  defaultNotesExpanded: false,
  exportBlankLineBetweenNotes: true,
  hidePluginBlockIds: true,
  noteFontFamily: "",
  noteFontSizePx: 16,
  noteEditorFontSizePx: 16,
  notePreviewFontSizePx: 16,
  buttonSizePx: 28,
  noteDirection: "auto",
  showAllVaultNotesButton: false,
  storeSideNoteIDInProperties: true,
  updateOnSelectionChange: true,
  updateDebounceMs: 150
};

const DEFAULT_DATA: SideNotesData = {
  files: {},
  sideNoteIds: {},
  filesBySideNoteId: {}
};

export default class SideNotesPlugin extends Plugin {
  settings: SideNotesSettings;
  sideNotesData: SideNotesData;
  currentContext: ParagraphContext | null = null;
  private debouncedRefresh: () => void;
  private lastMarkdownView: MarkdownView | null = null;

  async onload() {
    await this.loadSettings();
    await this.loadSideNotesData();
    void this.migrateLegacySideNotesIDProperties();

    this.debouncedRefresh = debounce(
      () => this.refreshContext(),
      this.settings.updateDebounceMs,
      true
    );

    this.registerView(
      VIEW_TYPE_SIDE_NOTES,
      (leaf) => new SideNotesView(leaf, this)
    );

    if (this.settings.hidePluginBlockIds) {
      this.registerEditorExtension(createBlockIdHiderExtension(this.settings.blockIdPrefix, this.usesMarkdownBlockIds()));
    }

    this.addRibbonIcon("sticky-note", "Open paragraph notes", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-paragraph-notes",
      name: "Open sidebar",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "import-sidenotes-bundle",
      name: "Import transfer file",
      callback: () => {
        void this.importSideNotesBundleFromDisk();
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.addSideNotesExportMenuItem(menu, [file]);
      })
    );

    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, files) => {
        this.addSideNotesExportMenuItem(menu, files);
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.debouncedRefresh())
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.debouncedRefresh())
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.handleRename(file, oldPath);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.handleDelete(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        void this.restoreSideNoteIDPropertyForFile(file);
      })
    );

    if (this.settings.updateOnSelectionChange) {
      this.registerDomEvent(activeDocument, "selectionchange", () => {
        this.debouncedRefresh();
      });
    }

    this.registerInterval(
      window.setInterval(() => this.debouncedRefresh(), 500)
    );

    this.addSettingTab(new SideNotesSettingTab(this.app, this));
  }

  onunload() {
    // Keep the sidebar leaf in place so Obsidian preserves the user's layout.
  }

  async activateView() {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDE_NOTES)[0];

    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      this.refreshContext();
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({
      type: VIEW_TYPE_SIDE_NOTES,
      active: true
    });

    if (leaf) {
      await this.app.workspace.revealLeaf(leaf);
    }

    this.refreshContext();
  }

  async loadSettings() {
    this.settings = getSideNotesSettingsFromPluginData(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadSideNotesData() {
    const externalData = await this.loadExternalSideNotesData();
    if (externalData) {
      this.sideNotesData = this.normalizeSideNotesData(externalData);
      await this.saveSideNotesData();
      return;
    }

    const legacyData = getPluginDataRecord(await this.loadData());
    this.sideNotesData = this.normalizeSideNotesData(Object.assign({}, DEFAULT_DATA, {
      files: getSideNotesFilesRecord(legacyData.files)
    }));

    if (Object.keys(this.sideNotesData.files).length > 0) {
      await this.saveSideNotesData();
    }
  }

  async savePluginState() {
    await this.saveSettings();
    await this.saveSideNotesData();
  }

  getSideNoteIDFromProperties(file: TFile): string | null {
    const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const value = getFrontmatterStringValue(frontmatter, SIDE_NOTES_ID_PROPERTY) ?? getFrontmatterStringValue(frontmatter, LEGACY_SIDE_NOTE_ID_PROPERTY);
    return value ? normalizeSideNotesId(value) : null;
  }

  isSideNotesIDInUse(sideNoteId: string): boolean {
    const normalizedSideNoteId = normalizeSideNotesId(sideNoteId);
    if (this.sideNotesData.filesBySideNoteId[normalizedSideNoteId]) {
      return true;
    }

    for (const mappedSideNoteId of Object.values(this.sideNotesData.sideNoteIds)) {
      if (normalizeSideNotesId(mappedSideNoteId) === normalizedSideNoteId) {
        return true;
      }
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.getSideNoteIDFromProperties(file) === normalizedSideNoteId) {
        return true;
      }
    }

    return false;
  }

  makeUnusedSideNotesID(): string {
    let sideNoteId = makeSideNotesId();
    while (this.isSideNotesIDInUse(sideNoteId)) {
      sideNoteId = makeSideNotesId();
    }

    return sideNoteId;
  }

  async ensureSideNoteIDProperty(file: TFile, sideNoteId: string, force = false) {
    if (!force && !this.settings.storeSideNoteIDInProperties) {
      return;
    }

    const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const current = getFrontmatterStringValue(frontmatter, SIDE_NOTES_ID_PROPERTY);
    if (current === sideNoteId) {
      return;
    }

    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter[SIDE_NOTES_ID_PROPERTY] = sideNoteId;
      delete frontmatter[LEGACY_SIDE_NOTE_ID_PROPERTY];
    });
  }

  async restoreSideNoteIDPropertyForFile(file: TAbstractFile) {
    if (!this.settings.storeSideNoteIDInProperties || !(file instanceof TFile) || file.extension !== "md") {
      return;
    }

    const storedFile = this.getStoredFileNotes(file);
    if (!storedFile) {
      return;
    }

    await this.ensureSideNoteIDProperty(file, storedFile.SideNoteID);
  }

  async migrateLegacySideNotesIDProperties() {
    if (!this.settings.storeSideNoteIDInProperties) {
      return;
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const sideNotesValue = getFrontmatterStringValue(frontmatter, SIDE_NOTES_ID_PROPERTY);
      const legacyValue = getFrontmatterStringValue(frontmatter, LEGACY_SIDE_NOTE_ID_PROPERTY);
      const value = sideNotesValue ?? legacyValue;
      if (!value) {
        continue;
      }

      const normalizedValue = normalizeSideNotesId(value);
      if (sideNotesValue === normalizedValue && !legacyValue) {
        continue;
      }

      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        frontmatter[SIDE_NOTES_ID_PROPERTY] = normalizedValue;
        delete frontmatter[LEGACY_SIDE_NOTE_ID_PROPERTY];
      });
    }
  }

  async loadExternalSideNotesData(): Promise<SideNotesData | null> {
    if (!(await this.app.vault.adapter.exists(SIDE_NOTES_DATA_PATH))) {
      return null;
    }

    try {
      const raw = await this.app.vault.adapter.read(SIDE_NOTES_DATA_PATH);
      const parsed = JSON.parse(raw) as Partial<SideNotesData>;
      return Object.assign({}, DEFAULT_DATA, {
        files: parsed.files ?? {},
        sideNoteIds: parsed.sideNoteIds ?? {},
        filesBySideNoteId: parsed.filesBySideNoteId ?? {},
        fileIds: parsed.fileIds ?? {},
        filesById: parsed.filesById ?? {}
      });
    } catch (error) {
      console.error("Failed to load side notes data", error);
      new Notice("Could not load _SideNotes data file.");
      return Object.assign({}, DEFAULT_DATA);
    }
  }

  async saveSideNotesData() {
    if (!(await this.app.vault.adapter.exists(SIDE_NOTES_FOLDER))) {
      await this.app.vault.createFolder(SIDE_NOTES_FOLDER);
    }

    await this.app.vault.adapter.write(
      SIDE_NOTES_DATA_PATH,
      JSON.stringify(this.sideNotesData, null, 2)
    );
  }

  normalizeSideNotesData(data: SideNotesData): SideNotesData {
    const normalized: SideNotesData = {
      files: data.files ?? {},
      sideNoteIds: {},
      filesBySideNoteId: {}
    };

    for (const [path, sideNoteId] of Object.entries(data.sideNoteIds ?? {})) {
      normalized.sideNoteIds[path] = normalizeSideNotesId(sideNoteId);
    }

    for (const [sideNoteId, storedFile] of Object.entries(data.filesBySideNoteId ?? {})) {
      const normalizedSideNoteId = normalizeSideNotesId(storedFile.SideNoteID ?? sideNoteId);
      normalized.filesBySideNoteId[normalizedSideNoteId] = {
        SideNoteID: normalizedSideNoteId,
        path: storedFile.path,
        name: storedFile.name,
        blocks: storedFile.blocks ?? {}
      };
    }

    for (const [path, legacyId] of Object.entries(data.fileIds ?? {})) {
      normalized.sideNoteIds[path] = normalized.sideNoteIds[path] ?? normalizeSideNotesId(legacyId);
    }

    for (const [legacyId, legacyFile] of Object.entries(data.filesById ?? {})) {
      const sideNoteId = normalizeSideNotesId(legacyFile.SideNoteID ?? legacyFile.id ?? legacyId);
      normalized.filesBySideNoteId[sideNoteId] = {
        SideNoteID: sideNoteId,
        path: legacyFile.path,
        name: legacyFile.name,
        blocks: legacyFile.blocks ?? {}
      };
    }

    for (const [sideNoteId, storedFile] of Object.entries(normalized.filesBySideNoteId)) {
      storedFile.SideNoteID = normalizeSideNotesId(storedFile.SideNoteID ?? sideNoteId);
    }

    for (const [path, blocks] of Object.entries(normalized.files)) {
      if (!normalized.sideNoteIds[path]) {
        const sideNoteId = makeSideNotesId();
        normalized.sideNoteIds[path] = sideNoteId;
        normalized.filesBySideNoteId[sideNoteId] = {
          SideNoteID: sideNoteId,
          path,
          name: getFileNameFromPath(path),
          blocks
        };
      } else {
        const sideNoteId = normalizeSideNotesId(normalized.sideNoteIds[path]);
        normalized.sideNoteIds[path] = sideNoteId;
        const storedFile = normalized.filesBySideNoteId[sideNoteId];
        if (storedFile) {
          storedFile.SideNoteID = normalizeSideNotesId(storedFile.SideNoteID ?? sideNoteId);
        }
      }
    }

    return normalized;
  }

  refreshContext() {
    const context = this.getCurrentParagraphContext();
    const sameContext =
      context?.filePath === this.currentContext?.filePath &&
      context?.fromLine === this.currentContext?.fromLine &&
      context?.toLine === this.currentContext?.toLine &&
      context?.blockId === this.currentContext?.blockId;

    this.currentContext = context;
    this.syncCurrentBlockIdentity(context);

    if (!sameContext) {
      this.refreshViews({ preserveScroll: true });
    }
  }

  refreshViews(options: RenderOptions = {}) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDE_NOTES)) {
      const view = leaf.view;
      if (view instanceof SideNotesView) {
        void view.render(options);
      }
    }
  }

  usesMarkdownBlockIds(): boolean {
    return this.settings.anchorStorage === "block-id";
  }

  private syncCurrentBlockIdentity(context: ParagraphContext | null) {
    if (!context?.blockId) {
      return;
    }

    const storedFile = this.getStoredFileNotes(context.file);
    const blockNotes = storedFile?.blocks[context.blockId];
    if (!blockNotes) {
      return;
    }

    const changed =
      blockNotes.fingerprint !== context.fingerprint ||
      blockNotes.fromLine !== context.fromLine ||
      blockNotes.toLine !== context.toLine;

    if (!changed) {
      return;
    }

    blockNotes.fingerprint = context.fingerprint;
    blockNotes.fromLine = context.fromLine;
    blockNotes.toLine = context.toLine;
    void this.saveSideNotesData();
  }

  getCurrentParagraphContext(): ParagraphContext | null {
    const markdownView = this.getCurrentMarkdownView();
    if (!markdownView?.file) {
      return null;
    }

    const editor = markdownView.editor;
    const cursor = editor.getCursor();
    const directParagraphRange = findParagraphRange(editor, cursor.line, this.settings.blockIdPrefix);
    const paragraphRange = directParagraphRange ?? findPreviousParagraphRangeFromBlankLine(editor, cursor.line, this.settings.blockIdPrefix);

    if (!paragraphRange) {
      return null;
    }

    const lines = [];
    for (let line = paragraphRange.fromLine; line <= paragraphRange.toLine; line++) {
      lines.push(editor.getLine(line));
    }

    const text = lines.join("\n");
    const blockIdInFile = getBlockId(text, this.settings.blockIdPrefix);
    const fingerprint = getParagraphFingerprint(text, this.settings.blockIdPrefix);
    const storedBlockId = this.findBlockIdForParagraph(markdownView.file, fingerprint, paragraphRange);
    const blockId = this.usesMarkdownBlockIds()
      ? blockIdInFile ?? storedBlockId
      : storedBlockId ?? blockIdInFile;
    if (!directParagraphRange && !blockId) {
      return null;
    }

    return {
      file: markdownView.file,
      filePath: markdownView.file.path,
      fileName: markdownView.file.basename,
      fromLine: paragraphRange.fromLine,
      toLine: paragraphRange.toLine,
      text,
      fingerprint,
      hasBlockIdInFile: this.usesMarkdownBlockIds() && blockIdInFile !== null && blockId === blockIdInFile,
      blockId
    };
  }

  getNotesForCurrentContext(): SideNote[] {
    const context = this.currentContext;
    if (!context?.blockId) {
      return [];
    }

    return this.getStoredFileNotes(context.file)?.blocks[context.blockId]?.notes ?? [];
  }

  getNoteGroupsForCurrentFile(): FileNoteGroup[] {
    const file = this.currentContext?.file ?? this.lastMarkdownView?.file;
    if (!file) {
      return [];
    }

    const fileNotes = this.getStoredFileNotes(file)?.blocks ?? {};
    return Object.entries(fileNotes)
      .map(([blockId, blockNotes]) => ({
        blockId,
        notes: blockNotes.notes,
        fingerprint: blockNotes.fingerprint
      }))
      .filter((group) => group.notes.length > 0)
      .sort((a, b) => a.blockId.localeCompare(b.blockId));
  }

  async getOrphanedFileNotes(): Promise<OrphanedFileNotes[]> {
    const orphanedFiles: OrphanedFileNotes[] = [];

    for (const storedFile of Object.values(this.sideNotesData.filesBySideNoteId)) {
      const groups = Object.entries(storedFile.blocks)
        .map(([blockId, blockNotes]) => ({
          blockId,
          notes: blockNotes.notes,
          fingerprint: blockNotes.fingerprint
        }))
        .filter((group) => group.notes.length > 0)
        .sort((a, b) => a.blockId.localeCompare(b.blockId));

      if (groups.length === 0 || this.isStoredFileAttached(storedFile)) {
        continue;
      }

      orphanedFiles.push({
        SideNoteID: storedFile.SideNoteID,
        path: storedFile.path,
        name: storedFile.name,
        groups
      });
    }

    return orphanedFiles.sort((a, b) =>
      a.SideNoteID.localeCompare(b.SideNoteID) || a.path.localeCompare(b.path)
    );
  }

  getAllStoredFileNotes(): StoredFileNoteSummary[] {
    return Object.values(this.sideNotesData.filesBySideNoteId)
      .map((storedFile) => {
        const groups = Object.entries(storedFile.blocks)
          .map(([blockId, blockNotes]) => ({
            blockId,
            notes: blockNotes.notes,
            fingerprint: blockNotes.fingerprint
          }))
          .filter((group) => group.notes.length > 0)
          .sort((a, b) => a.blockId.localeCompare(b.blockId));

        return {
          SideNoteID: storedFile.SideNoteID,
          path: storedFile.path,
          name: storedFile.name,
          groups,
          orphaned: !this.isStoredFileAttached(storedFile)
        };
      })
      .filter((file) => file.groups.length > 0)
      .sort((a, b) =>
        a.SideNoteID.localeCompare(b.SideNoteID) || a.path.localeCompare(b.path)
      );
  }

  getCurrentFileInfo(): CurrentFileInfo | null {
    const file = this.currentContext?.file ?? this.lastMarkdownView?.file;
    if (!file) {
      return null;
    }

    return {
      path: file.path,
      name: file.basename
    };
  }

  addSideNotesExportMenuItem(menu: Menu, files: TAbstractFile[]) {
    const exportableFiles = this.getExportableSideNotesFiles(files);
    if (exportableFiles.length === 0) {
      return;
    }

    menu.addItem((item) => {
      item
        .setTitle(exportableFiles.length === 1 ? "Export with SideNotes" : "Export selected files with SideNotes")
        .setIcon("package")
        .onClick(() => {
          void this.exportSideNotesBundle(exportableFiles);
        });
    });
  }

  getExportableSideNotesFiles(files: TAbstractFile[]): TFile[] {
    const seenPaths = new Set<string>();
    const exportableFiles: TFile[] = [];

    for (const file of files) {
      if (!(file instanceof TFile) || file.extension !== "md" || seenPaths.has(file.path) || !this.getSideNoteIDFromProperties(file)) {
        continue;
      }

      seenPaths.add(file.path);
      exportableFiles.push(file);
    }

    return exportableFiles;
  }

  async exportSideNotesBundle(files: TFile[]) {
    if (files.length === 0) {
      new Notice("No files with SideNotesID selected.");
      return;
    }

    const transferFiles: SideNotesTransferFile[] = [];
    for (const file of files) {
      const sideNoteId = this.getSideNoteIDFromProperties(file);
      if (!sideNoteId) {
        continue;
      }

      const storedFile = this.getStoredFileNotes(file);
      await this.ensureSideNoteIDProperty(file, sideNoteId, true);
      const content = await this.app.vault.read(file);
      const attachments = await this.getTransferAttachmentsForFile(file, content);
      transferFiles.push({
        path: file.path,
        name: file.name,
        basename: file.basename,
        content,
        SideNotesID: sideNoteId,
        blocks: cloneBlockNotesRecord(storedFile?.blocks ?? {}),
        attachments
      });
    }

    if (transferFiles.length === 0) {
      new Notice("No files with SideNotesID selected.");
      return;
    }

    const bundle: SideNotesTransferBundle = {
      type: SIDE_NOTES_BUNDLE_TYPE,
      version: SIDE_NOTES_BUNDLE_VERSION,
      exportedAt: Date.now(),
      files: transferFiles
    };

    const bundleText = JSON.stringify(bundle, null, 2);
    const suggestedName = this.getSideNotesBundleFileName(files);
    await this.saveSideNotesBundleWithPicker(bundleText, suggestedName, files);
  }

  async getTransferAttachmentsForFile(file: TFile, content: string): Promise<SideNotesTransferAttachment[]> {
    const attachmentFiles = this.getLinkedAttachmentFiles(file, content);
    const attachments: SideNotesTransferAttachment[] = [];

    for (const attachmentFile of attachmentFiles) {
      try {
        const data = await this.app.vault.readBinary(attachmentFile);
        attachments.push({
          path: attachmentFile.path,
          name: attachmentFile.name,
          data: arrayBufferToBase64(data)
        });
      } catch (error) {
        console.error(error);
      }
    }

    return attachments;
  }

  getLinkedAttachmentFiles(file: TFile, content: string): TFile[] {
    const seenPaths = new Set<string>();
    const attachmentFiles: TFile[] = [];

    const addLinkedFile = (linkedFile: TFile | null) => {
      if (!linkedFile || linkedFile.path === file.path || linkedFile.extension === "md" || seenPaths.has(linkedFile.path)) {
        return;
      }

      seenPaths.add(linkedFile.path);
      attachmentFiles.push(linkedFile);
    };

    const resolvedLinks = this.app.metadataCache.resolvedLinks[file.path] ?? {};
    for (const linkedPath of Object.keys(resolvedLinks)) {
      const linkedFile = this.app.vault.getAbstractFileByPath(linkedPath);
      if (linkedFile instanceof TFile) {
        addLinkedFile(linkedFile);
      }
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const references = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    for (const reference of references) {
      const linkPath = getInternalLinkPath(reference.link);
      if (linkPath) {
        addLinkedFile(this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path));
      }
    }

    for (const linkPath of extractInternalLinkPaths(content)) {
      addLinkedFile(this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path));
    }

    return attachmentFiles;
  }

  getSideNotesBundleFileName(files: TFile[]): string {
    return files.length === 1
      ? `${sanitizeFileName(files[0].basename) || "SideNotes export"}.sidenotes`
      : `SideNotes export ${getSafeTimestamp()}.sidenotes`;
  }

  async getAvailableSideNotesBundlePath(files: TFile[]): Promise<string> {
    const folder = getFolderPath(files[0]?.path ?? "");
    return this.getAvailableVaultPath(joinVaultPath(folder, this.getSideNotesBundleFileName(files)));
  }

  async saveSideNotesBundleWithPicker(bundleText: string, suggestedName: string, files: TFile[]) {
    const pickerWindow = window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName?: string;
        excludeAcceptAllOption?: boolean;
        types?: Array<{
          description: string;
          accept: Record<string, string[]>;
        }>;
      }) => Promise<SideNotesSaveFileHandle>;
    };

    if (typeof pickerWindow.showSaveFilePicker === "function") {
      try {
        const handle = await pickerWindow.showSaveFilePicker({
          suggestedName: removeSideNotesBundleExtension(suggestedName),
          excludeAcceptAllOption: false,
          types: [{
            description: "sidenotes",
            accept: {
              [SIDE_NOTES_BUNDLE_MIME_TYPE]: [".sidenotes"]
            }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(bundleText);
        await writable.close();
        new Notice("SideNotes export saved.");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        console.error(error);
        new Notice("Save dialog was not available. Saving inside the vault instead.");
      }
    }

    const exportPath = await this.getAvailableSideNotesBundlePath(files);
    await this.app.vault.create(exportPath, bundleText);
    new Notice(`Created ${exportPath}`);
  }

  async importSideNotesBundleFromDisk() {
    const input = activeDocument.createElement("input");
    input.type = "file";
    input.accept = ".sidenotes";

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }

      try {
        const result = await this.importSideNotesBundleText(await file.text());
        const attachmentText = result.attachmentCount > 0
          ? ` and ${result.attachmentCount} attachment${result.attachmentCount === 1 ? "" : "s"}`
          : "";
        new Notice(`Imported ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} with ${result.noteCount} side note${result.noteCount === 1 ? "" : "s"}${attachmentText}.`);
      } catch (error) {
        console.error(error);
        new Notice("Could not import this .sidenotes file.");
      }
    });

    input.click();
  }

  async importSideNotesBundleText(rawBundle: string): Promise<SideNotesImportResult> {
    const bundle = parseSideNotesTransferBundle(rawBundle);
    let fileCount = 0;
    let noteCount = 0;
    let attachmentCount = 0;

    for (const transferFile of bundle.files) {
      const importResult = await this.importSideNotesTransferFile(transferFile);
      fileCount += 1;
      noteCount += importResult.noteCount;
      attachmentCount += importResult.attachmentCount;
    }

    await this.savePluginState();
    this.refreshViews();
    return { fileCount, noteCount, attachmentCount };
  }

  async importSideNotesTransferFile(transferFile: SideNotesTransferFile): Promise<{ noteCount: number; attachmentCount: number }> {
    const requestedPath = sanitizeVaultPath(transferFile.path || transferFile.name || "Imported side notes.md");
    const importPath = await this.getAvailableImportedMarkdownPath(requestedPath);
    await this.ensureVaultFolder(getFolderPath(importPath));

    let sideNoteId = normalizeSideNotesId(transferFile.SideNotesID);
    if (!sideNoteId || this.isSideNotesIDInUse(sideNoteId)) {
      sideNoteId = this.makeUnusedSideNotesID();
    }

    const importedFile = await this.app.vault.create(importPath, transferFile.content ?? "");
    await this.ensureSideNoteIDProperty(importedFile, sideNoteId, true);

    const blocks = cloneBlockNotesRecord(transferFile.blocks ?? {});
    this.sideNotesData.sideNoteIds[importedFile.path] = sideNoteId;
    this.sideNotesData.filesBySideNoteId[sideNoteId] = {
      SideNoteID: sideNoteId,
      path: importedFile.path,
      name: importedFile.basename,
      blocks
    };

    delete this.sideNotesData.files[importedFile.path];
    const attachmentCount = await this.importSideNotesTransferAttachments(transferFile.attachments);
    return { noteCount: getBlockNotesCount(blocks), attachmentCount };
  }

  async importSideNotesTransferAttachments(attachments: SideNotesTransferAttachment[]): Promise<number> {
    let attachmentCount = 0;
    const seenPaths = new Set<string>();

    for (const attachment of attachments) {
      const attachmentPath = sanitizeOptionalVaultPath(attachment.path);
      if (!attachmentPath || seenPaths.has(attachmentPath)) {
        continue;
      }

      seenPaths.add(attachmentPath);
      if (await this.app.vault.adapter.exists(attachmentPath)) {
        continue;
      }

      try {
        await this.ensureVaultFolder(getFolderPath(attachmentPath));
        await this.app.vault.createBinary(attachmentPath, base64ToArrayBuffer(attachment.data));
        attachmentCount += 1;
      } catch (error) {
        console.error(error);
      }
    }

    return attachmentCount;
  }

  async getAvailableImportedMarkdownPath(path: string): Promise<string> {
    const normalizedPath = ensureMarkdownExtension(sanitizeVaultPath(path || "Imported side notes.md"));
    if (!(await this.app.vault.adapter.exists(normalizedPath))) {
      return normalizedPath;
    }

    const folder = getFolderPath(normalizedPath);
    const fileName = normalizedPath.split("/").pop() ?? "Imported side notes.md";
    const baseName = fileName.replace(/\.md$/i, "");
    return this.getAvailableVaultPath(joinVaultPath(folder, `${baseName} imported.md`));
  }

  async getAvailableVaultPath(path: string): Promise<string> {
    const folder = getFolderPath(path);
    const fileName = path.split("/").pop() ?? "SideNotes export.sidenotes";
    const extensionMatch = fileName.match(/(\.[^.]+)$/);
    const extension = extensionMatch?.[1] ?? "";
    const baseName = extension ? fileName.slice(0, -extension.length) : fileName;

    let candidate = joinVaultPath(folder, `${baseName}${extension}`);
    let index = 2;
    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = joinVaultPath(folder, `${baseName} ${index}${extension}`);
      index++;
    }

    return candidate;
  }

  async ensureVaultFolder(folder: string) {
    if (!folder) {
      return;
    }

    const parts = folder.split("/").filter(Boolean);
    let currentPath = "";
    for (const part of parts) {
      currentPath = joinVaultPath(currentPath, part);
      if (!(await this.app.vault.adapter.exists(currentPath))) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  async exportCurrentNotes(mode: "paragraph" | "file") {
    const context = this.currentContext;
    const file = context?.file ?? this.lastMarkdownView?.file;
    if (!file) {
      new Notice("No active file to export notes for.");
      return;
    }

    const storedFile = this.ensureStoredFileNotes(file);
    const groups = mode === "paragraph"
      ? this.getParagraphExportGroups(context)
      : this.getNoteGroupsForCurrentFile();

    if (groups.length === 0) {
      new Notice("No side notes to export.");
      return;
    }

    const title = `SideNotes (${storedFile.SideNoteID}) (${file.basename})`;
    const exportPath = await this.getAvailableExportPath(title);
    const content = this.buildExportMarkdown(title, file, storedFile, groups, mode);
    const createdFile = await this.app.vault.create(exportPath, content);
    await this.app.workspace.getLeaf(true).openFile(createdFile);
  }

  async exportSelectedNotesToFile(noteRefs: SideNoteReference[], viewMode: ViewMode) {
    if (noteRefs.length === 0) {
      new Notice("Select one or more side notes to export.");
      return;
    }

    const files = this.getSelectedExportFiles(noteRefs);
    if (files.length === 0) {
      new Notice("Could not find the selected side notes to export.");
      return;
    }

    const title = this.getSelectedExportTitle(viewMode, files);
    const exportPath = await this.getAvailableExportPath(title);
    const content = this.buildSelectedExportMarkdown(title, files);
    const createdFile = await this.app.vault.create(exportPath, content);
    await this.app.workspace.getLeaf(true).openFile(createdFile);
  }

  getSelectedExportFiles(noteRefs: SideNoteReference[]): StoredFileNoteSummary[] {
    const files: StoredFileNoteSummary[] = [];
    const filesBySideNoteId = new Map<string, StoredFileNoteSummary>();
    const groupsByFile = new Map<string, Map<string, FileNoteGroup>>();

    for (const noteRef of noteRefs) {
      const storedFile = this.getStoredFileNotesFromSource(noteRef.sourcePath, noteRef.sourceSideNoteId);
      const blockNotes = storedFile?.blocks[noteRef.blockId];
      const note = blockNotes?.notes.find((item) => item.id === noteRef.noteId);
      if (!storedFile || !blockNotes || !note) {
        continue;
      }

      const sideNoteId = normalizeSideNotesId(storedFile.SideNoteID);
      let exportFile = filesBySideNoteId.get(sideNoteId);
      if (!exportFile) {
        exportFile = {
          SideNoteID: sideNoteId,
          path: storedFile.path,
          name: storedFile.name,
          groups: [],
          orphaned: !this.isStoredFileAttached(storedFile)
        };
        filesBySideNoteId.set(sideNoteId, exportFile);
        groupsByFile.set(sideNoteId, new Map<string, FileNoteGroup>());
        files.push(exportFile);
      }

      const fileGroups = groupsByFile.get(sideNoteId);
      if (!fileGroups) {
        continue;
      }

      let exportGroup = fileGroups.get(noteRef.blockId);
      if (!exportGroup) {
        exportGroup = {
          blockId: noteRef.blockId,
          notes: [],
          fingerprint: blockNotes.fingerprint
        };
        fileGroups.set(noteRef.blockId, exportGroup);
        exportFile.groups.push(exportGroup);
      }

      exportGroup.notes.push(note);
    }

    return files.filter((file) => file.groups.some((group) => group.notes.length > 0));
  }

  getSelectedExportTitle(viewMode: ViewMode, files: StoredFileNoteSummary[]): string {
    if (files.length === 1) {
      return `SideNotes selected (${files[0].SideNoteID}) (${files[0].name})`;
    }

    return `SideNotes selected (${getCurrentViewModeLabel(viewMode)}) ${getSafeTimestamp()}`;
  }

  async openStoredFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("This file no longer exists.");
      return;
    }

    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async openFileAtBlock(path: string, blockId: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("This file no longer exists.");
      return;
    }

    const blockLine = await this.findBlockLine(file, blockId);
    if (blockLine === null) {
      new Notice("Could not find this paragraph block in the file.");
      return;
    }

    const leaf = this.lastMarkdownView?.leaf ?? this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    await this.app.workspace.revealLeaf(leaf);

    const markdownView = leaf.view instanceof MarkdownView ? leaf.view : this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) {
      return;
    }

    markdownView.editor.setCursor({ line: blockLine, ch: 0 });
    markdownView.editor.scrollIntoView({ from: { line: blockLine, ch: 0 }, to: { line: blockLine, ch: 0 } }, true);
    this.lastMarkdownView = markdownView;
    this.refreshContext();
  }

  async findBlockLine(file: TFile, blockId: string): Promise<number | null> {
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const blockPattern = new RegExp(`(?:^|\\s)\\^${escapeRegExp(blockId)}[^\\r\\n]*$`);

    for (let line = 0; line < lines.length; line++) {
      if (blockPattern.test(lines[line])) {
        return findParagraphStartLine(lines, line, this.settings.blockIdPrefix);
      }
    }

    const storedBlock = this.getStoredFileNotes(file)?.blocks[blockId];
    if (storedBlock?.fingerprint) {
      const fingerprintLine = findParagraphStartLineByFingerprint(lines, storedBlock.fingerprint, this.settings.blockIdPrefix);
      if (fingerprintLine !== null) {
        return fingerprintLine;
      }
    }

    if (storedBlock?.fromLine !== undefined && storedBlock.fromLine >= 0 && storedBlock.fromLine < lines.length) {
      const line = lines[storedBlock.fromLine];
      if (line.trim().length > 0 && !isFenceLine(line)) {
        return storedBlock.fromLine;
      }
    }

    return null;
  }

  getParagraphExportGroups(context: ParagraphContext | null): FileNoteGroup[] {
    if (!context?.blockId) {
      return [];
    }

    const blockNotes = this.getStoredFileNotes(context.file)?.blocks[context.blockId];
    if (!blockNotes || blockNotes.notes.length === 0) {
      return [];
    }

    return [{
      blockId: context.blockId,
      notes: blockNotes.notes,
      fingerprint: blockNotes.fingerprint
    }];
  }

  async getAvailableExportPath(title: string): Promise<string> {
    const safeName = sanitizeFileName(title);
    let path = `${safeName}.md`;
    let index = 2;

    while (await this.app.vault.adapter.exists(path)) {
      path = `${safeName} ${index}.md`;
      index++;
    }

    return path;
  }

  buildExportMarkdown(title: string, file: TFile, storedFile: StoredFileNotes, groups: FileNoteGroup[], mode: "paragraph" | "file"): string {
    const lines = [
      `# ${title}`,
      ""
    ];

    for (const group of groups) {
      lines.push(`## BlockID: ^${group.blockId}`, "");

      group.notes.forEach((note, index) => {
        lines.push(note.text);

        const isLastNoteInGroup = index === group.notes.length - 1;
        if (this.settings.exportBlankLineBetweenNotes || isLastNoteInGroup) {
          lines.push("");
        }
      });

    }

    return lines.join("\n");
  }

  buildSelectedExportMarkdown(title: string, files: StoredFileNoteSummary[]): string {
    const lines = [
      `# ${title}`,
      ""
    ];

    for (const file of files) {
      lines.push(
        `## ${file.name}`,
        `SideNotesID: ${file.SideNoteID}`,
        file.orphaned ? `Old path: ${file.path}` : `Path: ${file.path}`,
        ""
      );

      for (const group of file.groups) {
        lines.push(`### BlockID: ^${group.blockId}`, "");

        for (const note of group.notes) {
          lines.push(note.text);
          lines.push("");
        }
      }
    }

    return lines.join("\n");
  }

  async addNoteForCurrentContext(text: string, refreshViews = true): Promise<boolean> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      new Notice("Write a note first.");
      return false;
    }

    const context = await this.ensureCurrentContextHasBlockId();
    if (!context?.blockId) {
      return false;
    }

    const notes = this.ensureBlockNotes(context.file, context.blockId, context.fingerprint, context.fromLine, context.toLine);
    const now = Date.now();

    notes.push({
      id: makeId("note"),
      text: trimmedText,
      createdAt: now,
      updatedAt: now
    });

    await this.savePluginState();
    if (refreshViews) {
      this.refreshViews();
    }
    return true;
  }

  async updateNote(blockId: string, noteId: string, text: string, sourcePath?: string, sourceSideNoteId?: string) {
    const context = this.currentContext;
    const filePath = sourcePath ?? context?.filePath ?? this.lastMarkdownView?.file?.path;
    if (!filePath && !sourceSideNoteId) {
      return;
    }

    if (context && context.blockId === blockId) {
      await this.restoreMissingBlockIdIfNeeded(context, blockId);
    }

    const notes = this.getStoredFileNotesFromSource(filePath, sourceSideNoteId)?.blocks[blockId]?.notes;
    const note = notes?.find((item) => item.id === noteId);

    if (!note) {
      return;
    }

    note.text = text;
    if (context && context.blockId === blockId) {
      this.ensureBlockNotes(context.file, blockId, context.fingerprint, context.fromLine, context.toLine);
    }
    note.updatedAt = Date.now();
    await this.savePluginState();
    this.refreshViews();
  }

  async deleteNote(blockId: string, noteId: string, sourcePath?: string, sourceSideNoteId?: string) {
    const context = this.currentContext;
    const filePath = sourcePath ?? context?.filePath ?? this.lastMarkdownView?.file?.path;
    if (!filePath && !sourceSideNoteId) {
      return;
    }

    const blockNotes = this.getStoredFileNotesFromSource(filePath, sourceSideNoteId)?.blocks[blockId];
    if (!blockNotes) {
      return;
    }

    blockNotes.notes = blockNotes.notes.filter((note) => note.id !== noteId);
    await this.savePluginState();
    this.refreshViews();
  }

  async deleteSelectedNotes(noteRefs: SideNoteReference[]): Promise<number> {
    if (noteRefs.length === 0) {
      return 0;
    }

    let deletedCount = 0;
    for (const noteRef of noteRefs) {
      const sourceFile = this.getStoredFileNotesFromSource(noteRef.sourcePath, noteRef.sourceSideNoteId);
      const sourceBlock = sourceFile?.blocks[noteRef.blockId];
      if (!sourceFile || !sourceBlock) {
        continue;
      }

      const beforeCount = sourceBlock.notes.length;
      sourceBlock.notes = sourceBlock.notes.filter((note) => note.id !== noteRef.noteId);
      if (sourceBlock.notes.length === beforeCount) {
        continue;
      }

      deletedCount++;
      if (sourceBlock.notes.length === 0) {
        delete sourceFile.blocks[noteRef.blockId];
      }
    }

    if (deletedCount > 0) {
      await this.savePluginState();
      this.refreshViews();
    }

    return deletedCount;
  }

  async moveNotesToCurrentParagraph(noteRefs: SideNoteReference[]): Promise<number> {
    if (noteRefs.length === 0) {
      return 0;
    }

    const context = await this.ensureCurrentContextHasBlockId();
    if (!context?.blockId) {
      return 0;
    }

    const destinationFile = this.ensureStoredFileNotes(context.file);
    const destinationNotes = this.ensureBlockNotes(
      context.file,
      context.blockId,
      context.fingerprint,
      context.fromLine,
      context.toLine
    );
    let movedCount = 0;

    for (const noteRef of noteRefs) {
      const sourceFile = this.getStoredFileNotesFromSource(noteRef.sourcePath, noteRef.sourceSideNoteId);
      const sourceBlock = sourceFile?.blocks[noteRef.blockId];
      if (!sourceFile || !sourceBlock) {
        continue;
      }

      if (sourceFile.SideNoteID === destinationFile.SideNoteID && noteRef.blockId === context.blockId) {
        continue;
      }

      const noteIndex = sourceBlock.notes.findIndex((note) => note.id === noteRef.noteId);
      if (noteIndex === -1) {
        continue;
      }

      const [note] = sourceBlock.notes.splice(noteIndex, 1);
      destinationNotes.push(note);
      movedCount++;

      if (sourceBlock.notes.length === 0) {
        delete sourceFile.blocks[noteRef.blockId];
      }
    }

    if (movedCount > 0) {
      await this.savePluginState();
      this.refreshViews();
    }

    return movedCount;
  }

  async deleteAllNotesForSideNoteId(sideNoteId: string, removeStoredFile = true) {
    sideNoteId = normalizeSideNotesId(sideNoteId);
    const storedFile = this.sideNotesData.filesBySideNoteId[sideNoteId];
    if (!storedFile) {
      return;
    }

    if (removeStoredFile) {
      delete this.sideNotesData.sideNoteIds[storedFile.path];
      delete this.sideNotesData.files[storedFile.path];
      delete this.sideNotesData.filesBySideNoteId[sideNoteId];
    } else {
      storedFile.blocks = {};
      this.sideNotesData.files[storedFile.path] = {};
    }

    await this.savePluginState();
    this.refreshViews();
  }

  async ensureCurrentContextHasBlockId(): Promise<ParagraphContext | null> {
    const context = this.getCurrentParagraphContext();
    if (!context) {
      new Notice("Place the cursor inside a paragraph first.");
      return null;
    }

    if (context.blockId && context.hasBlockIdInFile) {
      this.currentContext = context;
      return context;
    }

    if (context.blockId && !this.usesMarkdownBlockIds()) {
      this.currentContext = context;
      return context;
    }

    if (!this.usesMarkdownBlockIds()) {
      const blockId = this.makeUniqueInternalBlockId(context.file);
      const updatedContext = {
        ...context,
        hasBlockIdInFile: false,
        blockId
      };

      this.currentContext = updatedContext;
      return updatedContext;
    }

    if (!this.settings.autoInsertBlockIds) {
      new Notice("This paragraph has no block ID. Enable automatic block IDs in settings.");
      return null;
    }

    const markdownView = this.getCurrentMarkdownView();
    if (!markdownView) {
      return null;
    }

    const blockId = await this.appendBlockId(markdownView.editor, context, context.blockId ?? undefined);
    const updatedContext = {
      ...context,
      text: `${context.text} ^${blockId}`,
      hasBlockIdInFile: true,
      blockId
    };

    this.currentContext = updatedContext;
    return updatedContext;
  }

  private makeUniqueInternalBlockId(file: TFile): string {
    let blockId = makeId(sanitizeBlockPrefix(this.settings.blockIdPrefix));

    while (this.getStoredFileNotes(file)?.blocks[blockId]) {
      blockId = makeId(sanitizeBlockPrefix(this.settings.blockIdPrefix));
    }

    return blockId;
  }

  private getCurrentMarkdownView(): MarkdownView | null {
    const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeMarkdownView?.file) {
      this.lastMarkdownView = activeMarkdownView;
      return activeMarkdownView;
    }

    const activeSideNotesView = this.app.workspace.getActiveViewOfType(SideNotesView);
    if (activeSideNotesView && this.lastMarkdownView?.file) {
      return this.lastMarkdownView;
    }

    return null;
  }

  async appendBlockId(editor: Editor, context: ParagraphContext, preferredBlockId?: string): Promise<string> {
    let blockId = preferredBlockId ?? makeId(sanitizeBlockPrefix(this.settings.blockIdPrefix));

    while (!preferredBlockId && this.getStoredFileNotes(context.file)?.blocks[blockId]) {
      blockId = makeId(sanitizeBlockPrefix(this.settings.blockIdPrefix));
    }

    if (preferredBlockId) {
      this.removeExistingBlockIdFromEditor(editor, preferredBlockId);
    }

    const lastLine = editor.getLine(context.toLine);
    const suffix = lastLine.trim().length > 0 ? ` ^${blockId}` : `^${blockId}`;

    editor.replaceRange(suffix, {
      line: context.toLine,
      ch: lastLine.length
    });

    return blockId;
  }

  private removeExistingBlockIdFromEditor(editor: Editor, blockId: string) {
    const blockIdTailPattern = new RegExp(`[ \\t\\u00a0]*\\^${escapeRegExp(blockId)}\\s*$`);

    for (let line = editor.lineCount() - 1; line >= 0; line--) {
      const lineText = editor.getLine(line);
      const match = lineText.match(blockIdTailPattern);
      if (!match || match.index === undefined) {
        continue;
      }

      editor.replaceRange("", { line, ch: match.index }, { line, ch: lineText.length });
    }
  }

  async restoreMissingBlockIdIfNeeded(context: ParagraphContext, blockId: string) {
    if (!this.usesMarkdownBlockIds()) {
      return;
    }

    if (context.hasBlockIdInFile || context.blockId !== blockId || !this.settings.autoInsertBlockIds) {
      return;
    }

    const markdownView = this.getCurrentMarkdownView();
    if (!markdownView) {
      return;
    }

    await this.appendBlockId(markdownView.editor, context, blockId);
    context.hasBlockIdInFile = true;
  }

  ensureBlockNotes(file: TFile, blockId: string, fingerprint?: string, fromLine?: number, toLine?: number): SideNote[] {
    const storedFile = this.ensureStoredFileNotes(file);

    if (!storedFile.blocks[blockId]) {
      storedFile.blocks[blockId] = { notes: [] };
    }

    if (fingerprint) {
      storedFile.blocks[blockId].fingerprint = fingerprint;
    }

    if (fromLine !== undefined) {
      storedFile.blocks[blockId].fromLine = fromLine;
    }

    if (toLine !== undefined) {
      storedFile.blocks[blockId].toLine = toLine;
    }

    return storedFile.blocks[blockId].notes;
  }

  findBlockIdForParagraph(file: TFile, fingerprint: string, range: { fromLine: number; toLine: number }): string | null {
    const storedFile = this.getStoredFileNotes(file);
    if (!storedFile) {
      return null;
    }

    if (fingerprint) {
      for (const [blockId, blockNotes] of Object.entries(storedFile.blocks)) {
        if (blockNotes.fingerprint === fingerprint) {
          return blockId;
        }
      }
    }

    for (const [blockId, blockNotes] of Object.entries(storedFile.blocks)) {
      if (blockNotes.fromLine === range.fromLine && blockNotes.toLine === range.toLine) {
        return blockId;
      }
    }

    let bestLineMatch: { blockId: string; score: number } | null = null;
    for (const [blockId, blockNotes] of Object.entries(storedFile.blocks)) {
      const score = getLineRangeMatchScore(blockNotes, range);
      if (score === 0) {
        continue;
      }

      if (!bestLineMatch || score > bestLineMatch.score) {
        bestLineMatch = { blockId, score };
      }
    }

    return bestLineMatch?.blockId ?? null;
  }

  ensureStoredFileNotes(file: TFile): StoredFileNotes {
    const propertySideNoteId = this.getSideNoteIDFromProperties(file);
    if (propertySideNoteId && this.sideNotesData.filesBySideNoteId[propertySideNoteId]) {
      const storedFile = this.sideNotesData.filesBySideNoteId[propertySideNoteId];
      storedFile.SideNoteID = propertySideNoteId;
      storedFile.path = file.path;
      storedFile.name = file.basename;
      this.sideNotesData.sideNoteIds[file.path] = propertySideNoteId;
      return storedFile;
    }

    const existing = this.getStoredFileNotes(file);
    if (existing) {
      existing.path = file.path;
      existing.name = file.basename;
      this.sideNotesData.sideNoteIds[file.path] = existing.SideNoteID;
      void this.ensureSideNoteIDProperty(file, existing.SideNoteID);
      return existing;
    }

    const sideNoteId = propertySideNoteId ?? makeSideNotesId();
    const storedFile: StoredFileNotes = {
      SideNoteID: sideNoteId,
      path: file.path,
      name: file.basename,
      blocks: {}
    };

    this.sideNotesData.sideNoteIds[file.path] = sideNoteId;
    this.sideNotesData.filesBySideNoteId[sideNoteId] = storedFile;
    void this.ensureSideNoteIDProperty(file, sideNoteId);
    return storedFile;
  }

  getStoredFileNotes(file: TFile): StoredFileNotes | null {
    const propertySideNoteId = this.getSideNoteIDFromProperties(file);
    if (propertySideNoteId && this.sideNotesData.filesBySideNoteId[propertySideNoteId]) {
      const storedFile = this.sideNotesData.filesBySideNoteId[propertySideNoteId];
      storedFile.SideNoteID = propertySideNoteId;
      this.sideNotesData.sideNoteIds[file.path] = propertySideNoteId;
      return storedFile;
    }

    const sideNoteId = this.sideNotesData.sideNoteIds[file.path];
    if (sideNoteId && this.sideNotesData.filesBySideNoteId[sideNoteId]) {
      const storedFile = this.sideNotesData.filesBySideNoteId[sideNoteId];
      storedFile.SideNoteID = storedFile.SideNoteID ?? sideNoteId;
      return storedFile;
    }

    return null;
  }

  getStoredFileNotesByPath(path: string): StoredFileNotes | null {
    const sideNoteId = this.sideNotesData.sideNoteIds[path];
    if (sideNoteId && this.sideNotesData.filesBySideNoteId[sideNoteId]) {
      const storedFile = this.sideNotesData.filesBySideNoteId[sideNoteId];
      storedFile.SideNoteID = storedFile.SideNoteID ?? sideNoteId;
      return storedFile;
    }

    for (const [storedSideNoteId, storedFile] of Object.entries(this.sideNotesData.filesBySideNoteId)) {
      if (storedFile.path === path) {
        storedFile.SideNoteID = storedFile.SideNoteID ?? storedSideNoteId;
        return storedFile;
      }
    }

    const legacyBlocks = this.sideNotesData.files[path];
    if (legacyBlocks) {
      const sideNoteId = makeSideNotesId();
      const storedFile: StoredFileNotes = {
        SideNoteID: sideNoteId,
        path,
        name: getFileNameFromPath(path),
        blocks: legacyBlocks
      };

      this.sideNotesData.sideNoteIds[path] = sideNoteId;
      this.sideNotesData.filesBySideNoteId[sideNoteId] = storedFile;
      return storedFile;
    }

    return null;
  }

  getStoredFileNotesFromSource(path?: string, sideNoteId?: string): StoredFileNotes | null {
    sideNoteId = sideNoteId ? normalizeSideNotesId(sideNoteId) : undefined;
    if (sideNoteId && this.sideNotesData.filesBySideNoteId[sideNoteId]) {
      return this.sideNotesData.filesBySideNoteId[sideNoteId];
    }

    return path ? this.getStoredFileNotesByPath(path) : null;
  }

  isStoredFileAttached(storedFile: StoredFileNotes): boolean {
    const file = this.app.vault.getAbstractFileByPath(storedFile.path);
    if (!(file instanceof TFile)) {
      return false;
    }

    if (this.sideNotesData.sideNoteIds[storedFile.path] === storedFile.SideNoteID) {
      return true;
    }

    return this.getSideNoteIDFromProperties(file) === storedFile.SideNoteID;
  }

  async handleDelete(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      this.refreshViews();
      return;
    }

    const sideNoteId = this.sideNotesData.sideNoteIds[file.path];
    const storedFile = sideNoteId ? this.sideNotesData.filesBySideNoteId[sideNoteId] : this.getStoredFileNotesByPath(file.path);

    delete this.sideNotesData.sideNoteIds[file.path];
    delete this.sideNotesData.files[file.path];

    if (storedFile) {
      storedFile.SideNoteID = storedFile.SideNoteID ?? sideNoteId ?? makeSideNotesId();
      storedFile.path = file.path;
      storedFile.name = file.basename;
    }

    await this.savePluginState();
    this.refreshContext();
  }

  async handleRename(file: TAbstractFile, oldPath: string) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return;
    }

    const sideNoteId = this.sideNotesData.sideNoteIds[oldPath];
    const storedFile = sideNoteId ? this.sideNotesData.filesBySideNoteId[sideNoteId] : this.getStoredFileNotesByPath(oldPath);
    if (!storedFile) {
      return;
    }

    delete this.sideNotesData.sideNoteIds[oldPath];
    storedFile.SideNoteID = storedFile.SideNoteID ?? sideNoteId ?? makeSideNotesId();
    this.sideNotesData.sideNoteIds[file.path] = storedFile.SideNoteID;
    storedFile.path = file.path;
    storedFile.name = file.basename;
    await this.savePluginState();
    this.refreshContext();
  }
}

class SideNotesView extends ItemView {
  private plugin: SideNotesPlugin;
  private draft = "";
  private composerCollapsed = false;
  private collapsedNotes = new Set<string>();
  private editingNotes = new Set<string>();
  private expandedNotes = new Set<string>();
  private expandedFileCards = new Set<string>();
  private selectedNotes = new Map<string, SideNoteReference>();
  private cutNotes: SideNoteReference[] = [];
  private orphanedNoteIds: string[] = [];
  private orphanedNoteRefs: SideNoteReference[] = [];
  private vaultNoteIds: string[] = [];
  private vaultNoteRefs: SideNoteReference[] = [];
  private viewMode: ViewMode = "paragraph";
  private shouldFocusComposer = false;

  constructor(leaf: WorkspaceLeaf, plugin: SideNotesPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_SIDE_NOTES;
  }

  getDisplayText() {
    return "Paragraph notes";
  }

  getIcon() {
    return "sticky-note";
  }

  async onOpen() {
    this.plugin.refreshContext();
    await this.render();
  }

  async render(options: RenderOptions = {}) {
    const { contentEl } = this;
    const scrollState = options.preserveScroll ? this.captureScrollState() : null;

    try {
      contentEl.empty();
      contentEl.addClass("side-notes-view");
      contentEl.setCssProps({
        "--side-notes-note-font-family": getNoteFontFamilyCssValue(this.plugin.settings.noteFontFamily),
        "--side-notes-editor-font-size": `${this.plugin.settings.noteEditorFontSizePx}px`,
        "--side-notes-preview-font-size": `${this.plugin.settings.notePreviewFontSizePx}px`,
        "--side-notes-button-size": `${this.plugin.settings.buttonSizePx}px`
      });

      const context = this.plugin.currentContext;
      const fileInfo = this.plugin.getCurrentFileInfo();
      this.renderHeader(contentEl, context, fileInfo);

      if (!context && this.viewMode !== "orphaned" && this.viewMode !== "vault" && (this.viewMode !== "file" || !fileInfo)) {
        contentEl.createDiv({
          cls: "side-notes-empty",
          text: "Place the cursor inside a paragraph in a Markdown note."
        });
        return;
      }

      const notes = context ? this.plugin.getNotesForCurrentContext() : [];

      if (this.viewMode === "file") {
        const groups = this.plugin.getNoteGroupsForCurrentFile();
        this.renderViewControls(contentEl, notes, this.getGroupNoteReferences(groups, fileInfo?.path ?? ""));
        await this.renderFileNotes(contentEl, fileInfo, groups);
        return;
      }

      if (this.viewMode === "orphaned") {
        const orphanedFiles = await this.plugin.getOrphanedFileNotes();
        this.orphanedNoteIds = orphanedFiles.flatMap((file) =>
          file.groups.flatMap((group) => group.notes.map((note) => note.id))
        );
        this.orphanedNoteRefs = orphanedFiles.flatMap((file) =>
          this.getGroupNoteReferences(file.groups, file.path, file.SideNoteID)
        );
        this.renderViewControls(contentEl, notes, this.orphanedNoteRefs);
        await this.renderOrphanedNotes(contentEl, orphanedFiles);
        return;
      }

      if (this.viewMode === "vault") {
        const storedFiles = this.plugin.getAllStoredFileNotes();
        this.vaultNoteIds = storedFiles.flatMap((file) =>
          file.groups.flatMap((group) => group.notes.map((note) => note.id))
        );
        this.vaultNoteRefs = storedFiles.flatMap((file) =>
          this.getGroupNoteReferences(file.groups, file.path, file.SideNoteID)
        );
        this.renderViewControls(contentEl, notes, this.vaultNoteRefs);
        await this.renderVaultNotes(contentEl, storedFiles);
        return;
      }

      this.renderViewControls(contentEl, notes, this.getCurrentParagraphNoteReferences(notes));

      if (!context) {
        return;
      }

      if (!this.composerCollapsed) {
        this.renderComposer(contentEl);
      }

      if (notes.length === 0) {
        contentEl.createDiv({
          cls: "side-notes-empty",
          text: "No notes for this paragraph yet."
        });
        return;
      }

      const listEl = contentEl.createDiv({ cls: "side-notes-list" });
      for (const note of notes) {
        await this.renderNote(listEl, context.filePath, context.blockId ?? "", note);
      }
    } finally {
      if (scrollState) {
        this.restoreScrollState(scrollState);
      }
    }
  }

  private captureScrollState(): SideNotesScrollState {
    const listEl = this.contentEl.querySelector(".side-notes-list");
    return {
      contentTop: this.contentEl.scrollTop,
      listTop: listEl instanceof HTMLElement ? listEl.scrollTop : 0
    };
  }

  private restoreScrollState(scrollState: SideNotesScrollState) {
    const listEl = this.contentEl.querySelector(".side-notes-list");
    const restore = () => {
      this.contentEl.scrollTop = scrollState.contentTop;
      if (listEl instanceof HTMLElement) {
        listEl.scrollTop = scrollState.listTop;
      }
    };

    restore();
    window.requestAnimationFrame(restore);
  }

  private renderHeader(parent: HTMLElement, context: ParagraphContext | null, fileInfo: CurrentFileInfo | null) {
    const headerEl = parent.createDiv({ cls: "side-notes-header" });
    const headerTopEl = headerEl.createDiv({ cls: "side-notes-header-top" });
    headerTopEl.createDiv({ cls: "side-notes-title", text: "Side Notes" });
    const modeBadgeEl = headerTopEl.createDiv({
      cls: "side-notes-mode-badge",
      attr: {
        "aria-label": getCurrentViewModeLabel(this.viewMode),
        title: getCurrentViewModeLabel(this.viewMode)
      }
    });
    const modeIconEl = modeBadgeEl.createSpan({ cls: "side-notes-mode-icon" });
    setIcon(modeIconEl, getCurrentViewModeIcon(this.viewMode));
    modeBadgeEl.createSpan({ cls: "side-notes-mode-label", text: getCurrentViewModeLabel(this.viewMode) });

    if (!context && !fileInfo && this.viewMode !== "orphaned" && this.viewMode !== "vault") {
      headerEl.createDiv({ cls: "side-notes-meta", text: "No paragraph selected" });
      return;
    }

    headerEl.createDiv({
      cls: "side-notes-meta",
      text: this.viewMode === "orphaned" || this.viewMode === "vault" ? "Vault notes" : context?.fileName ?? fileInfo?.name ?? ""
    });

    if (this.viewMode === "orphaned") {
      headerEl.createDiv({ cls: "side-notes-meta", text: "Orphaned notes" });
    } else if (this.viewMode === "vault") {
      headerEl.createDiv({ cls: "side-notes-meta", text: "All notes in all files" });
    } else if (context) {
      headerEl.createDiv({
        cls: "side-notes-meta",
        text: getBlockLabel(context, this.plugin.usesMarkdownBlockIds())
      });
    } else {
      headerEl.createDiv({ cls: "side-notes-meta", text: "All file notes" });
    }
  }

  private renderViewControls(parent: HTMLElement, notes: SideNote[], selectableNoteRefs: SideNoteReference[] = []) {
    const controlsEl = parent.createDiv({ cls: "side-notes-view-controls" });

    this.renderViewModeSelect(controlsEl);

    const selectionControlsEl = controlsEl.createDiv({ cls: "side-notes-selection-controls" });
    if (this.selectedNotes.size === 0) {
      this.renderSelectionToggleButton(
        selectionControlsEl,
        selectableNoteRefs,
        getSelectAllTooltip(this.viewMode),
        getClearAllTooltip(this.viewMode)
      );
    } else {
      addIconButton(selectionControlsEl, "trash-2", `Delete ${this.selectedNotes.size} selected note${this.selectedNotes.size === 1 ? "" : "s"}`, async () => {
        if (this.plugin.settings.confirmBeforeDelete) {
          const confirmed = await confirmInObsidian(this.plugin.app, `Delete ${this.selectedNotes.size} selected side note${this.selectedNotes.size === 1 ? "" : "s"}?`);
          if (!confirmed) {
            return;
          }
        }

        const deletedCount = await this.plugin.deleteSelectedNotes(Array.from(this.selectedNotes.values()));
        this.selectedNotes.clear();
        new Notice(`${deletedCount} note${deletedCount === 1 ? "" : "s"} deleted.`);
        void this.render();
      }).setDestructive();

      addIconButton(selectionControlsEl, "scissors", `Cut ${this.selectedNotes.size} selected note${this.selectedNotes.size === 1 ? "" : "s"}`, () => {
        this.cutNotes = Array.from(this.selectedNotes.values());
        this.selectedNotes.clear();
        new Notice(`${this.cutNotes.length} note${this.cutNotes.length === 1 ? "" : "s"} ready to paste.`);
        void this.render();
      });

      addIconButton(selectionControlsEl, "square-minus", `Clear ${this.selectedNotes.size} selected note${this.selectedNotes.size === 1 ? "" : "s"}`, () => {
        this.selectedNotes.clear();
        void this.render();
      });
    }

    if (this.viewMode === "paragraph") {
      addIconButton(
        controlsEl,
        this.composerCollapsed ? "plus" : "minus",
        this.composerCollapsed ? "Show new note" : "Hide new note",
        () => {
          this.composerCollapsed = !this.composerCollapsed;
          void this.render();
        }
      );
    }

    if (selectableNoteRefs.length > 0) {
      addIconButton(controlsEl, "file-output", "Export notes to file", async () => {
        await this.plugin.exportSelectedNotesToFile(this.getSelectedNoteRefsForView(selectableNoteRefs), this.viewMode);
      });
    }

    if (this.cutNotes.length > 0 && this.viewMode === "paragraph") {
      addIconButton(controlsEl, "clipboard-paste", `Paste ${this.cutNotes.length} cut note${this.cutNotes.length === 1 ? "" : "s"} here`, async () => {
        const movedCount = await this.plugin.moveNotesToCurrentParagraph(this.cutNotes);
        if (movedCount > 0) {
          this.cutNotes = [];
          this.selectedNotes.clear();
        }
        new Notice(`${movedCount} note${movedCount === 1 ? "" : "s"} moved.`);
        void this.render();
      }).setCta();
    }

    if (this.cutNotes.length > 0) {
      addIconButton(controlsEl, "x", "Cancel cut notes", () => {
        this.cutNotes = [];
        void this.render();
      });
    }

    addIconButton(controlsEl, "chevrons-down", "Open all notes", () => {
        this.openNotes(this.getVisibleNoteIds(notes));
        void this.render();
    });

    addIconButton(controlsEl, "chevrons-up", "Close all notes", () => {
        this.closeNotes(this.getVisibleNoteIds(notes));
        void this.render();
    });
  }

  private renderViewModeSelect(parent: HTMLElement) {
    const selectEl = parent.createEl("select", {
      cls: "side-notes-view-mode-select",
      attr: {
        "aria-label": "Choose notes view",
        title: "Choose notes view"
      }
    });

    const modes = this.getAvailableViewModes();
    for (const mode of modes) {
      const optionEl = selectEl.createEl("option", { text: getCurrentViewModeLabel(mode) });
      optionEl.value = mode;
    }

    selectEl.value = modes.includes(this.viewMode) ? this.viewMode : "paragraph";
    selectEl.addEventListener("change", () => {
      const selectedMode = selectEl.value as ViewMode;
      if (selectedMode === this.viewMode || !modes.includes(selectedMode)) {
        return;
      }

      this.selectedNotes.clear();
      this.viewMode = selectedMode;
      void this.render();
    });
  }

  private getAvailableViewModes(): ViewMode[] {
    const modes: ViewMode[] = ["paragraph", "file", "orphaned"];
    if (this.plugin.settings.showAllVaultNotesButton || this.viewMode === "vault") {
      modes.push("vault");
    }

    return modes;
  }

  private renderSelectionToggleButton(parent: HTMLElement, noteRefs: SideNoteReference[], selectTooltip: string, clearTooltip: string) {
    const selectableNoteRefs = noteRefs.filter((noteRef) => !this.isNoteCut(noteRef));
    if (selectableNoteRefs.length === 0) {
      return;
    }

    const allSelected = this.areAllNoteRefsSelected(selectableNoteRefs);
    addIconButton(
      parent,
      allSelected ? "square-minus" : "check-square",
      allSelected ? clearTooltip : selectTooltip,
      () => {
        this.toggleNoteRefsSelection(selectableNoteRefs);
        void this.render();
      }
    );
  }

  private areAllNoteRefsSelected(noteRefs: SideNoteReference[]): boolean {
    return noteRefs.length > 0 && noteRefs.every((noteRef) => this.selectedNotes.has(this.getNoteReferenceKey(noteRef)));
  }

  private toggleNoteRefsSelection(noteRefs: SideNoteReference[]) {
    if (this.areAllNoteRefsSelected(noteRefs)) {
      for (const noteRef of noteRefs) {
        this.selectedNotes.delete(this.getNoteReferenceKey(noteRef));
      }
      return;
    }

    for (const noteRef of noteRefs) {
      this.selectedNotes.set(this.getNoteReferenceKey(noteRef), noteRef);
    }
  }

  private getSelectedNoteRefsForView(noteRefs: SideNoteReference[]): SideNoteReference[] {
    return noteRefs.filter((noteRef) => this.selectedNotes.has(this.getNoteReferenceKey(noteRef)));
  }

  private async renderFileNotes(parent: HTMLElement, fileInfo: CurrentFileInfo | null, groups = this.plugin.getNoteGroupsForCurrentFile()) {
    if (groups.length === 0) {
      parent.createDiv({
        cls: "side-notes-empty",
        text: "No notes saved for this file yet."
      });
      return;
    }

    const listEl = parent.createDiv({ cls: "side-notes-list" });
    for (const group of groups) {
      const groupEl = listEl.createDiv({ cls: "side-notes-group" });
      const groupHeaderEl = groupEl.createDiv({ cls: "side-notes-group-header" });
      groupHeaderEl.createDiv({
        cls: "side-notes-group-title",
        text: `^${group.blockId}`
      });
      this.renderSelectionToggleButton(
        groupHeaderEl,
        this.getGroupNoteReferences([group], fileInfo?.path ?? ""),
        "Select all notes in this paragraph",
        "Clear selection in this paragraph"
      );

      if (group.fingerprint) {
        groupEl.createDiv({
          cls: "side-notes-group-meta",
          text: group.fingerprint
        });
      }

      for (const note of group.notes) {
        await this.renderNote(groupEl, fileInfo?.path ?? "", group.blockId, note, undefined, true);
      }
    }
  }

  private async renderOrphanedNotes(parent: HTMLElement, orphanedFiles?: OrphanedFileNotes[]) {
    orphanedFiles = orphanedFiles ?? await this.plugin.getOrphanedFileNotes();
    const storedFileCount = Object.values(this.plugin.sideNotesData.filesBySideNoteId)
      .filter((file) => Object.values(file.blocks).some((block) => block.notes.length > 0))
      .length;

    if (orphanedFiles.length === 0) {
      parent.createDiv({
        cls: "side-notes-empty",
        text: `No orphaned notes found. Files with saved notes: ${storedFileCount}.`
      });
      return;
    }

    const listEl = parent.createDiv({ cls: "side-notes-list" });
    for (const orphanedFile of orphanedFiles) {
      const fileCardKey = getFileCardKey("orphaned", orphanedFile.SideNoteID);
      const isExpanded = this.expandedFileCards.has(fileCardKey);
      const fileEl = listEl.createDiv({ cls: "side-notes-orphaned-file" });
      const fileHeaderEl = fileEl.createDiv({ cls: "side-notes-file-header" });
      addIconButton(fileHeaderEl, isExpanded ? "chevron-up" : "chevron-down", isExpanded ? "Close file notes" : "Open file notes", () => {
        this.toggleFileCard(fileCardKey);
        void this.render();
      });
      fileHeaderEl.createDiv({
        cls: "side-notes-group-title",
        text: `Missing file: ${orphanedFile.name}`
      });
      this.renderSelectionToggleButton(
        fileHeaderEl,
        this.getGroupNoteReferences(orphanedFile.groups, orphanedFile.path, orphanedFile.SideNoteID),
        "Select all notes in this file",
        "Clear selection in this file"
      );
      addIconButton(fileHeaderEl, "trash-2", "Delete all notes for this missing file", async () => {
        const confirmed = await confirmInObsidian(this.plugin.app, `Delete all side notes for missing file "${orphanedFile.name}"?`);
        if (!confirmed) {
          return;
        }

        await this.plugin.deleteAllNotesForSideNoteId(orphanedFile.SideNoteID);
      }).setDestructive();
      fileEl.createDiv({
        cls: "side-notes-group-meta",
        text: `SideNotesID: ${orphanedFile.SideNoteID}`
      });
      fileEl.createDiv({
        cls: "side-notes-group-meta",
        text: `Old path: ${orphanedFile.path}`
      });
      fileEl.createDiv({
        cls: "side-notes-group-meta",
        text: `${getFileNoteCount(orphanedFile.groups)} notes`
      });

      if (!isExpanded) {
        continue;
      }

      for (const group of orphanedFile.groups) {
        const groupEl = fileEl.createDiv({ cls: "side-notes-group" });
        const groupHeaderEl = groupEl.createDiv({ cls: "side-notes-group-header" });
        groupHeaderEl.createDiv({
          cls: "side-notes-group-title",
          text: `^${group.blockId}`
        });
        this.renderSelectionToggleButton(
          groupHeaderEl,
          this.getGroupNoteReferences([group], orphanedFile.path, orphanedFile.SideNoteID),
          "Select all notes in this paragraph",
          "Clear selection in this paragraph"
        );

        if (group.fingerprint) {
          groupEl.createDiv({
            cls: "side-notes-group-meta",
            text: group.fingerprint
          });
        }

        for (const note of group.notes) {
          await this.renderNote(groupEl, orphanedFile.path, group.blockId, note, orphanedFile.SideNoteID);
        }
      }
    }
  }

  private async renderVaultNotes(parent: HTMLElement, storedFiles = this.plugin.getAllStoredFileNotes()) {
    if (storedFiles.length === 0) {
      parent.createDiv({
        cls: "side-notes-empty",
        text: "No side notes saved in the vault yet."
      });
      return;
    }

    const listEl = parent.createDiv({ cls: "side-notes-list" });
    for (const storedFile of storedFiles) {
      const fileCardKey = getFileCardKey("vault", storedFile.SideNoteID);
      const isExpanded = this.expandedFileCards.has(fileCardKey);
      const fileEl = listEl.createDiv({ cls: "side-notes-orphaned-file" });
      const fileHeaderEl = fileEl.createDiv({ cls: "side-notes-file-header" });
      addIconButton(fileHeaderEl, isExpanded ? "chevron-up" : "chevron-down", isExpanded ? "Close file notes" : "Open file notes", () => {
        this.toggleFileCard(fileCardKey);
        void this.render();
      });
      fileHeaderEl.createDiv({
        cls: "side-notes-group-title",
        text: storedFile.orphaned ? `Missing file: ${storedFile.name}` : storedFile.name
      });
      if (!storedFile.orphaned) {
        addIconButton(fileHeaderEl, "folder-open", "Open file", async () => {
          await this.plugin.openStoredFile(storedFile.path);
        });
      }
      this.renderSelectionToggleButton(
        fileHeaderEl,
        this.getGroupNoteReferences(storedFile.groups, storedFile.path, storedFile.SideNoteID),
        "Select all notes in this file",
        "Clear selection in this file"
      );
      addIconButton(fileHeaderEl, "trash-2", "Delete all notes for this file", async () => {
        const confirmed = await confirmInObsidian(this.plugin.app, `Delete all side notes for "${storedFile.name}"?`);
        if (!confirmed) {
          return;
        }

        await this.plugin.deleteAllNotesForSideNoteId(storedFile.SideNoteID, storedFile.orphaned);
      }).setDestructive();

      fileEl.createDiv({
        cls: "side-notes-group-meta",
        text: `SideNotesID: ${storedFile.SideNoteID}`
      });
      fileEl.createDiv({
        cls: "side-notes-group-meta",
        text: storedFile.orphaned ? `Old path: ${storedFile.path}` : `Path: ${storedFile.path}`
      });
      fileEl.createDiv({
        cls: "side-notes-group-meta",
        text: `${getFileNoteCount(storedFile.groups)} notes`
      });

      if (!isExpanded) {
        continue;
      }

      for (const group of storedFile.groups) {
        const groupEl = fileEl.createDiv({ cls: "side-notes-group" });
        const groupHeaderEl = groupEl.createDiv({ cls: "side-notes-group-header" });
        groupHeaderEl.createDiv({
          cls: "side-notes-group-title",
          text: `^${group.blockId}`
        });
        this.renderSelectionToggleButton(
          groupHeaderEl,
          this.getGroupNoteReferences([group], storedFile.path, storedFile.SideNoteID),
          "Select all notes in this paragraph",
          "Clear selection in this paragraph"
        );

        if (group.fingerprint) {
          groupEl.createDiv({
            cls: "side-notes-group-meta",
            text: group.fingerprint
          });
        }

        for (const note of group.notes) {
          await this.renderNote(groupEl, storedFile.path, group.blockId, note, storedFile.SideNoteID);
        }
      }
    }
  }

  private getVisibleNoteIds(currentParagraphNotes: SideNote[]): string[] {
    if (this.viewMode === "paragraph") {
      return currentParagraphNotes.map((note) => note.id);
    }

    if (this.viewMode === "orphaned") {
      return this.orphanedNoteIds;
    }

    if (this.viewMode === "vault") {
      return this.vaultNoteIds;
    }

    return this.plugin
      .getNoteGroupsForCurrentFile()
      .flatMap((group) => group.notes.map((note) => note.id));
  }

  private getCurrentParagraphNoteReferences(notes: SideNote[]): SideNoteReference[] {
    const context = this.plugin.currentContext;
    if (!context?.blockId) {
      return [];
    }

    return notes.map((note) => this.getNoteReference(context.filePath, context.blockId ?? "", note));
  }

  private getGroupNoteReferences(groups: FileNoteGroup[], sourcePath: string, sourceSideNoteId?: string): SideNoteReference[] {
    return groups.flatMap((group) =>
      group.notes.map((note) => this.getNoteReference(sourcePath, group.blockId, note, sourceSideNoteId))
    );
  }

  private renderComposer(parent: HTMLElement) {
    const composerEl = parent.createDiv({ cls: "side-notes-composer" });
    const textarea = composerEl.createEl("textarea", {
      cls: "side-notes-textarea",
      attr: {
        placeholder: "Write a Markdown note..."
      }
    });

    applyNoteDirection(textarea, this.plugin.settings.noteDirection);
    applyNoteEditorStyles(textarea, this.plugin.settings);
    enableMarkdownListContinuation(textarea);
    textarea.value = this.draft;
    enableTextareaAutoResize(textarea);
    if (this.shouldFocusComposer) {
      this.shouldFocusComposer = false;
      window.requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;
      });
    }

    textarea.addEventListener("input", () => {
      this.draft = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }

      event.preventDefault();
      this.draft = textarea.value;
      void this.addDraftNote();
    });

    this.renderToolbar(composerEl, textarea);

    new ButtonComponent(composerEl)
      .setButtonText("Add note")
      .setCta()
      .onClick(() => {
        void this.addDraftNote();
      });
  }

  private async addDraftNote() {
    const noteAdded = await this.plugin.addNoteForCurrentContext(this.draft, false);
    if (noteAdded) {
      this.draft = "";
    }

    this.shouldFocusComposer = true;
    void this.render();
  }

  private getNoteReference(sourcePath: string, blockId: string, note: SideNote, sourceSideNoteId?: string): SideNoteReference {
    return {
      sourcePath,
      sourceSideNoteId,
      blockId,
      noteId: note.id
    };
  }

  private getNoteReferenceKey(noteRef: SideNoteReference): string {
    const sourceId = noteRef.sourceSideNoteId
      ? normalizeSideNotesId(noteRef.sourceSideNoteId)
      : this.plugin.sideNotesData.sideNoteIds[noteRef.sourcePath] ?? noteRef.sourcePath;
    return `${sourceId}:${noteRef.blockId}:${noteRef.noteId}`;
  }

  private isNoteCut(noteRef: SideNoteReference): boolean {
    const noteRefKey = this.getNoteReferenceKey(noteRef);
    return this.cutNotes.some((cutNote) => this.getNoteReferenceKey(cutNote) === noteRefKey);
  }

  private async renderNote(parent: HTMLElement, sourcePath: string, blockId: string, note: SideNote, sourceSideNoteId?: string, showJumpButton = false) {
    const cardEl = parent.createDiv({ cls: "side-notes-card" });
    const noteRef = this.getNoteReference(sourcePath, blockId, note, sourceSideNoteId);
    const noteRefKey = this.getNoteReferenceKey(noteRef);
    const isCut = this.isNoteCut(noteRef);
    if (isCut) {
      cardEl.addClass("side-notes-card-cut");
    }

    const selectRowEl = cardEl.createDiv({ cls: "side-notes-card-select-row" });
    const selectInputEl = selectRowEl.createEl("input", {
      type: "checkbox",
      cls: "side-notes-note-checkbox",
      attr: {
        "aria-label": "Select note",
        title: "Select note"
      }
    });
    selectInputEl.checked = this.selectedNotes.has(noteRefKey);
    selectInputEl.disabled = isCut;
    selectInputEl.addEventListener("change", () => {
      if (selectInputEl.checked) {
        this.selectedNotes.set(noteRefKey, noteRef);
      } else {
        this.selectedNotes.delete(noteRefKey);
      }

      void this.render();
    });

    const isEditing = this.editingNotes.has(note.id);

    if (isEditing) {
      const textarea = cardEl.createEl("textarea", {
        cls: "side-notes-textarea"
      });
      applyNoteDirection(textarea, this.plugin.settings.noteDirection);
      applyNoteEditorStyles(textarea, this.plugin.settings);
      enableMarkdownListContinuation(textarea);
      textarea.value = note.text;
      enableTextareaAutoResize(textarea);
      this.renderToolbar(cardEl, textarea);

      const actionsEl = cardEl.createDiv({ cls: "side-notes-edit-actions" });
      addIconButton(actionsEl, "x", "Cancel", () => {
          this.editingNotes.delete(note.id);
          void this.render();
      });

      const saveActionsEl = actionsEl.createDiv({ cls: "side-notes-edit-save" });
      addIconButton(saveActionsEl, "save", "Save", async () => {
          this.editingNotes.delete(note.id);
          await this.plugin.updateNote(blockId, note.id, textarea.value.trim(), sourcePath, sourceSideNoteId);
      }).setCta();
    } else {
      const isExpanded = this.isNoteExpanded(note.id);
      if (isExpanded) {
        const previewEl = cardEl.createDiv({ cls: "side-notes-preview markdown-rendered" });
        applyNoteDirection(previewEl, this.plugin.settings.noteDirection);
        await MarkdownRenderer.render(
          this.plugin.app,
          note.text,
          previewEl,
          sourcePath,
          this
        );
      } else {
        const summaryEl = cardEl.createDiv({
          cls: "side-notes-summary",
          text: getFirstNoteLine(note.text)
        });
        applyNoteDirection(summaryEl, this.plugin.settings.noteDirection);
      }

      const actionsEl = cardEl.createDiv({ cls: "side-notes-actions" });
      addIconButton(actionsEl, isExpanded ? "chevron-up" : "chevron-down", isExpanded ? "Close" : "Open", () => {
          if (isExpanded) {
            this.closeNotes([note.id]);
          } else {
            this.openNotes([note.id]);
          }

          void this.render();
      });

      if (showJumpButton) {
        addIconButton(actionsEl, "locate-fixed", "Jump to paragraph", async () => {
          await this.plugin.openFileAtBlock(sourcePath, blockId);
        });
      }

      addIconButton(actionsEl, "pencil", "Edit", () => {
          this.editingNotes.add(note.id);
          void this.render();
      });

      addIconButton(actionsEl, "trash-2", "Delete", async () => {
          if (this.plugin.settings.confirmBeforeDelete) {
            const confirmed = await confirmInObsidian(this.plugin.app, "Delete this side note?");
            if (!confirmed) {
              return;
            }
          }

          const activeElement = activeDocument.activeElement instanceof HTMLElement ? activeDocument.activeElement : null;
          if (activeElement) {
            activeElement.blur();
          }

          await this.plugin.deleteNote(blockId, note.id, sourcePath, sourceSideNoteId);
      });
    }

    cardEl.createDiv({
      cls: "side-notes-timestamp",
      text: `Updated ${new Date(note.updatedAt).toLocaleString()}`
    });
  }

  private renderToolbar(parent: HTMLElement, textarea: HTMLTextAreaElement) {
    const toolbarEl = parent.createDiv({ cls: "side-notes-toolbar" });

    addToolbarButton(toolbarEl, "Bullet list", "-", () => {
      applyLinePrefix(textarea, "- ");
    });

    addToolbarButton(toolbarEl, "Numbered list", "1.", () => {
      applyLinePrefix(textarea, "1. ");
    });

    addToolbarButton(toolbarEl, "Checkbox", "[ ]", () => {
      applyLinePrefix(textarea, "- [ ] ");
    });

    addToolbarButton(toolbarEl, "Bold", "B", () => {
      wrapSelection(textarea, "**", "**");
    });

    addToolbarButton(toolbarEl, "Italic", "I", () => {
      wrapSelection(textarea, "*", "*");
    });

    addToolbarButton(toolbarEl, "Inline code", "`", () => {
      wrapSelection(textarea, "`", "`");
    });

    addToolbarButton(toolbarEl, "Obsidian link", "[[", () => {
      wrapSelection(textarea, "[[", "]]");
    });
  }

  private isNoteExpanded(noteId: string): boolean {
    if (this.plugin.settings.defaultNotesExpanded) {
      return !this.collapsedNotes.has(noteId);
    }

    return this.expandedNotes.has(noteId);
  }

  private openNotes(noteIds: string[]) {
    for (const noteId of noteIds) {
      this.expandedNotes.add(noteId);
      this.collapsedNotes.delete(noteId);
    }
  }

  private closeNotes(noteIds: string[]) {
    for (const noteId of noteIds) {
      this.expandedNotes.delete(noteId);
      this.collapsedNotes.add(noteId);
    }
  }

  private toggleFileCard(fileCardKey: string) {
    if (this.expandedFileCards.has(fileCardKey)) {
      this.expandedFileCards.delete(fileCardKey);
      return;
    }

    this.expandedFileCards.add(fileCardKey);
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private resolve: (confirmed: boolean) => void;
  private resolved = false;

  constructor(app: App, message: string, resolve: (confirmed: boolean) => void) {
    super(app);
    this.message = message;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName("Confirm delete")
      .setHeading();
    contentEl.createEl("p", { text: this.message });

    const actionsEl = contentEl.createDiv({ cls: "side-notes-modal-actions" });
    new ButtonComponent(actionsEl)
      .setButtonText("Cancel")
      .onClick(() => this.finish(false));

    new ButtonComponent(actionsEl)
      .setButtonText("Delete")
      .setDestructive()
      .onClick(() => this.finish(true));
  }

  onClose() {
    if (!this.resolved) {
      this.finish(false);
    }
  }

  private finish(confirmed: boolean) {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.resolve(confirmed);
    this.close();
  }
}

function confirmInObsidian(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, message, resolve).open();
  });
}

class SideNotesSettingTab extends PluginSettingTab {
  plugin: SideNotesPlugin;

  constructor(app: App, plugin: SideNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Paragraph notes settings")
      .setHeading();

    new Setting(containerEl)
      .setName("Paragraph anchor storage")
      .setDesc("Choose whether paragraph anchors stay internal to the plugin data or are written as Obsidian Block IDs in Markdown.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("internal", "Internal anchors")
          .addOption("block-id", "Markdown Block IDs")
          .setValue(this.plugin.settings.anchorStorage)
          .onChange(async (value: "internal" | "block-id") => {
            this.plugin.settings.anchorStorage = value;
            await this.plugin.saveSettings();
            new Notice("Reload Obsidian to apply paragraph anchor storage.");
          });
      });

    new Setting(containerEl)
      .setName("Automatically add block IDs")
      .setDesc("Only applies when paragraph anchor storage is set to Markdown Block IDs.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoInsertBlockIds)
          .onChange(async (value) => {
            this.plugin.settings.autoInsertBlockIds = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Block ID prefix")
      .setDesc("Used for internal anchors and for Markdown Block IDs when that storage mode is enabled.")
      .addText((text) => {
        text
          .setPlaceholder("side-note")
          .setValue(this.plugin.settings.blockIdPrefix)
          .onChange(async (value) => {
            this.plugin.settings.blockIdPrefix = sanitizeBlockPrefix(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Hide plugin block IDs in editor")
      .setDesc("Hides generated side-note Block IDs in the editor. In internal-anchor mode this only hides old Block IDs already present in the Markdown.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.hidePluginBlockIds)
          .onChange(async (value) => {
            this.plugin.settings.hidePluginBlockIds = value;
            await this.plugin.saveSettings();
            new Notice("Reload Obsidian to apply block ID hiding.");
          });
      });

    new Setting(containerEl)
      .setName("Confirm before deleting notes")
      .setDesc("Ask for confirmation before deleting a side note.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.confirmBeforeDelete)
          .onChange(async (value) => {
            this.plugin.settings.confirmBeforeDelete = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show all-vault notes option")
      .setDesc("Adds an all-vault view to the sidebar view dropdown.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showAllVaultNotesButton)
          .onChange(async (value) => {
            this.plugin.settings.showAllVaultNotesButton = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Open notes by default")
      .setDesc("When enabled, notes are shown open by default. When disabled, notes are shown collapsed by default.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.defaultNotesExpanded)
          .onChange(async (value) => {
            this.plugin.settings.defaultNotesExpanded = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Blank line between exported notes")
      .setDesc("When exporting, add an empty line between notes that belong to the same paragraph or BlockID.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.exportBlankLineBetweenNotes)
          .onChange(async (value) => {
            this.plugin.settings.exportBlankLineBetweenNotes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Store SideNotesID in file properties")
      .setDesc("Adds a SideNotesID property to Markdown files and restores it if it is removed or changed.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.storeSideNoteIDInProperties)
          .onChange(async (value) => {
            this.plugin.settings.storeSideNoteIDInProperties = value;
            await this.plugin.saveSettings();
            const file = this.app.workspace.getActiveFile();
            if (value && file) {
              const storedFile = this.plugin.ensureStoredFileNotes(file);
              await this.plugin.ensureSideNoteIDProperty(file, storedFile.SideNoteID);
              await this.plugin.savePluginState();
            }
          });
      });

    new Setting(containerEl)
      .setName("Import .sidenotes file")
      .setDesc("Import Markdown files and their SideNotes from a .sidenotes transfer file.")
      .addButton((button) => {
        button
          .setButtonText("Import")
          .setCta()
          .onClick(() => {
            void this.plugin.importSideNotesBundleFromDisk();
          });
      });

    let noteFontDropdown: DropdownComponent | null = null;
    new Setting(containerEl)
      .setName("Note font")
      .setDesc("Choose the font family for note editing and note previews. Use refresh if the installed font list does not load automatically.")
      .addDropdown((dropdown) => {
        noteFontDropdown = dropdown;
        this.populateNoteFontDropdown(dropdown, []);
        dropdown.onChange(async (value) => {
          this.plugin.settings.noteFontFamily = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
        void this.loadInstalledFontsIntoDropdown(dropdown);
      })
      .addButton((button) => {
        button
          .setIcon("refresh-cw")
          .setTooltip("Load installed fonts")
          .onClick(() => {
            if (noteFontDropdown) {
              void this.loadInstalledFontsIntoDropdown(noteFontDropdown, true);
            }
          });
      });

    new Setting(containerEl)
      .setName("Editor font size")
      .setDesc("Controls the text size for the new-note editor and note editing.")
      .addSlider((slider) => {
        slider
          .setLimits(12, 56, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.noteEditorFontSizePx)
          .onChange(async (value) => {
            this.plugin.settings.noteEditorFontSizePx = value;
            this.plugin.settings.noteFontSizePx = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Preview font size")
      .setDesc("Controls the text size for rendered and collapsed note previews.")
      .addSlider((slider) => {
        slider
          .setLimits(12, 56, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.notePreviewFontSizePx)
          .onChange(async (value) => {
            this.plugin.settings.notePreviewFontSizePx = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Button size")
      .setDesc("Controls the size of sidebar icon buttons.")
      .addSlider((slider) => {
        slider
          .setLimits(22, 56, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.buttonSizePx)
          .onChange(async (value) => {
            this.plugin.settings.buttonSizePx = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Note text direction")
      .setDesc("Choose the writing direction for notes in the sidebar.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("auto", "Auto")
          .addOption("rtl", "Right to left")
          .addOption("ltr", "Left to right")
          .setValue(this.plugin.settings.noteDirection)
          .onChange(async (value: "auto" | "rtl" | "ltr") => {
            this.plugin.settings.noteDirection = value;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          });
      });

    new Setting(containerEl)
      .setName("Update on selection changes")
      .setDesc("Refresh the sidebar as the editor selection changes.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.updateOnSelectionChange)
          .onChange(async (value) => {
            this.plugin.settings.updateOnSelectionChange = value;
            await this.plugin.saveSettings();
            new Notice("Reload Obsidian to apply this listener setting.");
          });
      });

    new Setting(containerEl)
      .setName("Update debounce")
      .setDesc("Delay before refreshing the sidebar, in milliseconds.")
      .addText((text) => {
        text
          .setPlaceholder("150")
          .setValue(String(this.plugin.settings.updateDebounceMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isNaN(parsed) && parsed >= 0) {
              this.plugin.settings.updateDebounceMs = parsed;
              await this.plugin.saveSettings();
            }
          });
      });
  }

  private populateNoteFontDropdown(dropdown: DropdownComponent, installedFontFamilies: string[]) {
    const currentFontFamily = this.plugin.settings.noteFontFamily.trim();
    const fontFamilies = getUniqueFontFamilies([
      currentFontFamily,
      ...installedFontFamilies,
      ...FALLBACK_NOTE_FONT_FAMILIES
    ]);

    dropdown.selectEl.textContent = "";
    dropdown.addOption("", DEFAULT_NOTE_FONT_LABEL);
    for (const fontFamily of fontFamilies) {
      dropdown.addOption(fontFamily, fontFamily);
    }
    dropdown.setValue(this.plugin.settings.noteFontFamily);
  }

  private async loadInstalledFontsIntoDropdown(dropdown: DropdownComponent, showNotice = false) {
    const installedFontFamilies = await getInstalledFontFamilies();
    if (installedFontFamilies.length === 0) {
      if (showNotice) {
        new Notice("Installed fonts could not be loaded. Showing fallback fonts.");
      }
      return;
    }

    this.populateNoteFontDropdown(dropdown, installedFontFamilies);
    if (showNotice) {
      new Notice(`${installedFontFamilies.length} installed font families loaded.`);
    }
  }
}

function findParagraphRange(editor: Editor, cursorLine: number, pluginBlockPrefix?: string): { fromLine: number; toLine: number } | null {
  const lineCount = editor.lineCount();
  if (cursorLine < 0 || cursorLine >= lineCount) {
    return null;
  }

  const currentLine = editor.getLine(cursorLine);
  if (currentLine.trim().length === 0 || isFenceLine(currentLine)) {
    return null;
  }

  let fromLine = cursorLine;
  while (fromLine > 0) {
    const previousLine = editor.getLine(fromLine - 1);
    if (previousLine.trim().length === 0 || isFenceLine(previousLine) || lineEndsWithBlockId(previousLine, pluginBlockPrefix)) {
      break;
    }
    fromLine--;
  }

  let toLine = cursorLine;
  while (toLine < lineCount - 1) {
    const currentRangeLine = editor.getLine(toLine);
    if (lineEndsWithBlockId(currentRangeLine, pluginBlockPrefix)) {
      break;
    }

    const nextLine = editor.getLine(toLine + 1);
    if (nextLine.trim().length === 0 || isFenceLine(nextLine)) {
      break;
    }
    toLine++;
  }

  return { fromLine, toLine };
}

function findPreviousParagraphRangeFromBlankLine(editor: Editor, cursorLine: number, pluginBlockPrefix?: string): { fromLine: number; toLine: number } | null {
  if (cursorLine <= 0 || cursorLine >= editor.lineCount()) {
    return null;
  }

  const currentLine = editor.getLine(cursorLine);
  if (currentLine.trim().length > 0 || isFenceLine(currentLine)) {
    return null;
  }

  const previousLine = editor.getLine(cursorLine - 1);
  if (previousLine.trim().length === 0 || isFenceLine(previousLine)) {
    return null;
  }

  return findParagraphRange(editor, cursorLine - 1, pluginBlockPrefix);
}

function lineEndsWithBlockId(line: string, pluginBlockPrefix?: string): boolean {
  return getBlockId(line, pluginBlockPrefix) !== null;
}

function findParagraphStartLine(lines: string[], blockLine: number, pluginBlockPrefix?: string): number {
  let fromLine = blockLine;

  while (fromLine > 0) {
    const previousLine = lines[fromLine - 1];
    if (previousLine.trim().length === 0 || isFenceLine(previousLine) || lineEndsWithBlockId(previousLine, pluginBlockPrefix)) {
      break;
    }

    fromLine--;
  }

  return fromLine;
}

function findParagraphStartLineByFingerprint(lines: string[], fingerprint: string, pluginBlockPrefix?: string): number | null {
  if (!fingerprint) {
    return null;
  }

  for (let line = 0; line < lines.length; line++) {
    const currentLine = lines[line];
    if (currentLine.trim().length === 0 || isFenceLine(currentLine)) {
      continue;
    }

    let toLine = line;
    while (toLine < lines.length - 1) {
      if (lineEndsWithBlockId(lines[toLine], pluginBlockPrefix)) {
        break;
      }

      const nextLine = lines[toLine + 1];
      if (nextLine.trim().length === 0 || isFenceLine(nextLine)) {
        break;
      }

      toLine++;
    }

    const paragraphText = lines.slice(line, toLine + 1).join("\n");
    if (getParagraphFingerprint(paragraphText, pluginBlockPrefix) === fingerprint) {
      return line;
    }

    line = toLine;
  }

  return null;
}

function getLineRangeMatchScore(blockNotes: BlockNotes, range: { fromLine: number; toLine: number }): number {
  if (blockNotes.fromLine === undefined || blockNotes.toLine === undefined) {
    return 0;
  }

  const overlapFrom = Math.max(blockNotes.fromLine, range.fromLine);
  const overlapTo = Math.min(blockNotes.toLine, range.toLine);
  if (overlapFrom > overlapTo) {
    return 0;
  }

  const overlapLines = overlapTo - overlapFrom + 1;
  const currentContainsStored = range.fromLine <= blockNotes.fromLine && range.toLine >= blockNotes.toLine;
  const storedContainsCurrent = blockNotes.fromLine <= range.fromLine && blockNotes.toLine >= range.toLine;
  const startDistance = Math.abs(blockNotes.fromLine - range.fromLine);
  const endDistance = Math.abs(blockNotes.toLine - range.toLine);
  const containmentBonus = currentContainsStored || storedContainsCurrent ? 100 : 0;

  return containmentBonus + overlapLines * 10 - startDistance - endDistance;
}

function getBlockId(text: string, pluginBlockPrefix?: string): string | null {
  const match = text.match(BLOCK_ID_PATTERN);
  if (match?.[1]) {
    return match[1];
  }

  return getGeneratedPluginBlockId(text, pluginBlockPrefix);
}

function getParagraphFingerprint(text: string, pluginBlockPrefix?: string): string {
  return stripBlockId(text, pluginBlockPrefix)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

function stripBlockId(text: string, pluginBlockPrefix?: string): string {
  const stripped = text.replace(BLOCK_ID_PATTERN, "").trim();
  if (stripped !== text.trim()) {
    return stripped;
  }

  const generatedPattern = getGeneratedPluginBlockTailPattern(pluginBlockPrefix);
  return generatedPattern ? text.replace(generatedPattern, "").trim() : stripped;
}

function getGeneratedPluginBlockId(text: string, pluginBlockPrefix?: string): string | null {
  const pattern = getGeneratedPluginBlockTailPattern(pluginBlockPrefix);
  const match = pattern ? text.match(pattern) : null;
  return match?.[1] ?? null;
}

function getGeneratedPluginBlockTailPattern(pluginBlockPrefix?: string): RegExp | null {
  if (!pluginBlockPrefix) {
    return null;
  }

  const safePrefix = escapeRegExp(sanitizeBlockPrefix(pluginBlockPrefix));
  return new RegExp(`(?:^|\\s)\\^(${safePrefix}-[A-Za-z0-9]{6,64})[^\\r\\n]*$`);
}

function parseSideNotesTransferBundle(rawBundle: string): SideNotesTransferBundle {
  const parsed = JSON.parse(rawBundle) as unknown;
  if (!isRecord(parsed) || parsed.type !== SIDE_NOTES_BUNDLE_TYPE || parsed.version !== SIDE_NOTES_BUNDLE_VERSION || !Array.isArray(parsed.files)) {
    throw new Error("Invalid SideNotes transfer bundle.");
  }

  const files = parsed.files.map((file) => {
    if (!isRecord(file) || typeof file.content !== "string") {
      throw new Error("Invalid SideNotes transfer file.");
    }

    return {
      path: typeof file.path === "string" ? file.path : "Imported side notes.md",
      name: typeof file.name === "string" ? file.name : getFileNameFromPath(typeof file.path === "string" ? file.path : "Imported side notes.md"),
      basename: typeof file.basename === "string" ? file.basename : getFileNameFromPath(typeof file.path === "string" ? file.path : "Imported side notes.md"),
      content: file.content,
      SideNotesID: typeof file.SideNotesID === "string" ? normalizeSideNotesId(file.SideNotesID) : makeSideNotesId(),
      blocks: isRecord(file.blocks) ? cloneBlockNotesRecord(file.blocks as Record<string, BlockNotes>) : {},
      attachments: parseSideNotesTransferAttachments(file.attachments)
    };
  });

  return {
    type: SIDE_NOTES_BUNDLE_TYPE,
    version: SIDE_NOTES_BUNDLE_VERSION,
    exportedAt: typeof parsed.exportedAt === "number" ? parsed.exportedAt : Date.now(),
    files
  };
}

function parseSideNotesTransferAttachments(value: unknown): SideNotesTransferAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const attachments: SideNotesTransferAttachment[] = [];
  for (const attachment of value) {
    if (!isRecord(attachment) || typeof attachment.path !== "string" || typeof attachment.data !== "string") {
      continue;
    }

    const path = sanitizeOptionalVaultPath(attachment.path);
    if (!path) {
      continue;
    }

    attachments.push({
      path,
      name: typeof attachment.name === "string" ? attachment.name : getLeafFileName(path),
      data: attachment.data
    });
  }

  return attachments;
}

function getSideNotesSettingsFromPluginData(rawData: unknown): SideNotesSettings {
  const data = getPluginDataRecord(rawData);
  const noteFontSizePx = getNumberValue(data.noteFontSizePx, DEFAULT_SETTINGS.noteFontSizePx);

  return {
    anchorStorage: data.anchorStorage === "block-id" ? "block-id" : "internal",
    autoInsertBlockIds: getBooleanValue(data.autoInsertBlockIds, DEFAULT_SETTINGS.autoInsertBlockIds),
    blockIdPrefix: getStringValue(data.blockIdPrefix, DEFAULT_SETTINGS.blockIdPrefix),
    confirmBeforeDelete: getBooleanValue(data.confirmBeforeDelete, DEFAULT_SETTINGS.confirmBeforeDelete),
    defaultNotesExpanded: getBooleanValue(data.defaultNotesExpanded, DEFAULT_SETTINGS.defaultNotesExpanded),
    exportBlankLineBetweenNotes: getBooleanValue(data.exportBlankLineBetweenNotes, DEFAULT_SETTINGS.exportBlankLineBetweenNotes),
    hidePluginBlockIds: getBooleanValue(data.hidePluginBlockIds, DEFAULT_SETTINGS.hidePluginBlockIds),
    noteFontFamily: getStringValue(data.noteFontFamily, DEFAULT_SETTINGS.noteFontFamily),
    noteFontSizePx,
    noteEditorFontSizePx: getNumberValue(data.noteEditorFontSizePx, noteFontSizePx),
    notePreviewFontSizePx: getNumberValue(data.notePreviewFontSizePx, noteFontSizePx),
    buttonSizePx: getNumberValue(data.buttonSizePx, DEFAULT_SETTINGS.buttonSizePx),
    noteDirection: getNoteDirectionValue(data.noteDirection, DEFAULT_SETTINGS.noteDirection),
    showAllVaultNotesButton: getBooleanValue(data.showAllVaultNotesButton, DEFAULT_SETTINGS.showAllVaultNotesButton),
    storeSideNoteIDInProperties: getBooleanValue(data.storeSideNoteIDInProperties, DEFAULT_SETTINGS.storeSideNoteIDInProperties),
    updateOnSelectionChange: getBooleanValue(data.updateOnSelectionChange, DEFAULT_SETTINGS.updateOnSelectionChange),
    updateDebounceMs: getNumberValue(data.updateDebounceMs, DEFAULT_SETTINGS.updateDebounceMs)
  };
}

function getPluginDataRecord(rawData: unknown): Record<string, unknown> {
  return isRecord(rawData) ? rawData : {};
}

function getSideNotesFilesRecord(value: unknown): Record<string, Record<string, BlockNotes>> {
  return isRecord(value) ? value as Record<string, Record<string, BlockNotes>> : {};
}

function getFrontmatterStringValue(frontmatter: unknown, key: string): string | null {
  if (!isRecord(frontmatter)) {
    return null;
  }

  const value = frontmatter[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getBooleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function getNumberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getStringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function getNoteDirectionValue(value: unknown, fallback: "auto" | "rtl" | "ltr"): "auto" | "rtl" | "ltr" {
  return value === "auto" || value === "rtl" || value === "ltr" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneBlockNotesRecord(blocks: Record<string, BlockNotes>): Record<string, BlockNotes> {
  const clonedBlocks: Record<string, BlockNotes> = {};

  for (const [blockId, blockNotes] of Object.entries(blocks)) {
    clonedBlocks[blockId] = {
      notes: (blockNotes.notes ?? []).map((note) => ({ ...note })),
      fingerprint: blockNotes.fingerprint,
      fromLine: blockNotes.fromLine,
      toLine: blockNotes.toLine
    };
  }

  return clonedBlocks;
}

function getBlockNotesCount(blocks: Record<string, BlockNotes>): number {
  return Object.values(blocks).reduce((count, blockNotes) => count + (blockNotes.notes?.length ?? 0), 0);
}

function getFolderPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function joinVaultPath(folder: string, name: string): string {
  return [folder, name].filter((part) => part.length > 0).join("/");
}

function sanitizeVaultPath(path: string): string {
  return sanitizeOptionalVaultPath(path) ?? "Imported side notes.md";
}

function sanitizeOptionalVaultPath(path: string): string | null {
  const normalizedPath = path.replace(/\\/g, "/");
  const parts = normalizedPath.split("/").filter((part) => part.length > 0);
  const sanitizedParts = parts.map((part) => sanitizeFileName(part)).filter((part) => part.length > 0);
  return sanitizedParts.join("/") || null;
}

function ensureMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

function removeSideNotesBundleExtension(name: string): string {
  return name.replace(/\.sidenotes$/i, "");
}

function getSafeTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", " ")
    .replace("Z", "");
}

function getFileNameFromPath(path: string): string {
  const fileName = getLeafFileName(path);
  return fileName.replace(/\.md$/i, "");
}

function getLeafFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function extractInternalLinkPaths(content: string): string[] {
  const linkPaths: string[] = [];
  const addLinkPath = (rawLink: string) => {
    const linkPath = getInternalLinkPath(rawLink);
    if (linkPath) {
      linkPaths.push(linkPath);
    }
  };

  const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
  let wikiLinkMatch: RegExpExecArray | null;
  while ((wikiLinkMatch = wikiLinkPattern.exec(content)) !== null) {
    addLinkPath(wikiLinkMatch[1]);
  }

  const markdownLinkPattern = /!?\[[^\]]*\]\(([^)\r\n]+)\)/g;
  let markdownLinkMatch: RegExpExecArray | null;
  while ((markdownLinkMatch = markdownLinkPattern.exec(content)) !== null) {
    addLinkPath(markdownLinkMatch[1]);
  }

  return linkPaths;
}

function getInternalLinkPath(rawLink: string): string | null {
  let link = stripMarkdownLinkDestination(rawLink);
  if (!link || isExternalOrSpecialLink(link)) {
    return null;
  }

  const aliasIndex = link.indexOf("|");
  if (aliasIndex !== -1) {
    link = link.slice(0, aliasIndex);
  }

  const subpathIndex = link.search(/[?#]/);
  if (subpathIndex !== -1) {
    link = link.slice(0, subpathIndex);
  }

  link = decodeUriSafely(link.trim());
  return link && !isExternalOrSpecialLink(link) ? link : null;
}

function stripMarkdownLinkDestination(rawLink: string): string {
  let link = rawLink.trim();
  if (link.startsWith("<")) {
    const closeIndex = link.indexOf(">");
    if (closeIndex !== -1) {
      return link.slice(1, closeIndex).trim();
    }
  }

  const titleIndex = link.search(/\s+["']/);
  if (titleIndex !== -1) {
    link = link.slice(0, titleIndex).trim();
  }

  if ((link.startsWith("\"") && link.endsWith("\"")) || (link.startsWith("'") && link.endsWith("'"))) {
    link = link.slice(1, -1).trim();
  }

  return link;
}

function isExternalOrSpecialLink(link: string): boolean {
  return link.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(link);
}

function decodeUriSafely(value: string): string {
  try {
    return decodeURI(value);
  } catch (error) {
    return value;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function getFirstNoteLine(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? "Empty note";
}

function getBlockLabel(context: ParagraphContext, usesMarkdownBlockIds: boolean): string {
  if (!context.blockId) {
    return usesMarkdownBlockIds
      ? "Block ID will be added when you create a note"
      : "Internal anchor will be created when you create a note";
  }

  if (!context.hasBlockIdInFile) {
    return usesMarkdownBlockIds
      ? `Recovered block: ^${context.blockId}. It will be restored when you add or edit a note.`
      : `Internal anchor: ${context.blockId}`;
  }

  return `Block: ^${context.blockId}`;
}

function getCurrentViewModeIcon(viewMode: ViewMode): string {
  if (viewMode === "paragraph") {
    return "pilcrow";
  }

  if (viewMode === "file") {
    return "file-text";
  }

  if (viewMode === "vault") {
    return "library";
  }

  return "archive";
}

function getCurrentViewModeLabel(viewMode: ViewMode): string {
  if (viewMode === "paragraph") {
    return "Current paragraph";
  }

  if (viewMode === "file") {
    return "All notes in file";
  }

  if (viewMode === "vault") {
    return "All notes in vault";
  }

  return "Orphaned notes";
}

function getSelectAllTooltip(viewMode: ViewMode): string {
  if (viewMode === "paragraph") {
    return "Select all notes in this paragraph";
  }

  if (viewMode === "file") {
    return "Select all notes in this file";
  }

  if (viewMode === "vault") {
    return "Select all notes in all files";
  }

  return "Select all orphaned notes";
}

function getClearAllTooltip(viewMode: ViewMode): string {
  if (viewMode === "paragraph") {
    return "Clear selection in this paragraph";
  }

  if (viewMode === "file") {
    return "Clear selection in this file";
  }

  if (viewMode === "vault") {
    return "Clear selection in all files";
  }

  return "Clear selection in orphaned notes";
}

function getFileCardKey(viewMode: "orphaned" | "vault", sideNoteId: string): string {
  return `${viewMode}:${sideNoteId}`;
}

function getFileNoteCount(groups: FileNoteGroup[]): number {
  return groups.reduce((count, group) => count + group.notes.length, 0);
}

function makeId(prefix: string): string {
  return `${prefix}-${makeRandomIdPart(24)}`;
}

function makeSideNotesId(): string {
  return makeId(SIDE_NOTES_ID_PREFIX);
}

function normalizeSideNotesId(sideNoteId: string): string {
  const trimmedSideNoteId = sideNoteId.trim();
  const legacyPrefix = `${LEGACY_SIDE_NOTE_ID_PREFIX}-`;
  if (trimmedSideNoteId.startsWith(legacyPrefix)) {
    return `${SIDE_NOTES_ID_PREFIX}-${trimmedSideNoteId.slice(legacyPrefix.length)}`;
  }

  return trimmedSideNoteId;
}

function makeRandomIdPart(length: number): string {
  let value = "";
  while (value.length < length) {
    value += Math.random().toString(36).slice(2);
  }

  return value.slice(0, length);
}

function sanitizeBlockPrefix(prefix: string): string {
  return (prefix || "side-note")
    .trim()
    .replace(/^\^+/, "")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "side-note";
}

function isFenceLine(line: string): boolean {
  return line.trim().startsWith("```");
}

function addToolbarButton(parent: HTMLElement, label: string, text: string, onClick: () => void) {
  const button = parent.createEl("button", {
    text,
    attr: {
      "aria-label": label,
      title: label
    }
  });

  button.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
}

function addIconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void | Promise<void>): ButtonComponent {
  return new ButtonComponent(parent)
    .setIcon(icon)
    .setTooltip(label)
    .onClick(() => {
      void onClick();
    });
}

function applyNoteDirection(element: HTMLElement, direction: "auto" | "rtl" | "ltr") {
  element.setAttribute("dir", direction);

  if (direction === "rtl") {
    element.setCssProps({ "text-align": "right" });
  } else if (direction === "ltr") {
    element.setCssProps({ "text-align": "left" });
  } else {
    element.setCssProps({ "text-align": "start" });
  }
}

function applyNoteEditorStyles(textarea: HTMLTextAreaElement, settings: SideNotesSettings) {
  textarea.setCssProps({
    "font-family": settings.noteFontFamily || "",
    "font-size": `${settings.noteEditorFontSizePx}px`,
    "line-height": "1.5",
    "white-space": "pre-wrap",
    "overflow-wrap": "anywhere",
    "word-break": "break-word"
  });
}

function enableTextareaAutoResize(textarea: HTMLTextAreaElement) {
  const resize = () => {
    textarea.setCssProps({ height: "auto" });
    textarea.setCssProps({ height: `${textarea.scrollHeight}px` });
  };

  textarea.addEventListener("input", resize);
  window.requestAnimationFrame(resize);
}

function getNoteFontFamilyCssValue(fontFamily: string): string {
  const trimmedFontFamily = fontFamily.trim();
  return trimmedFontFamily ? JSON.stringify(trimmedFontFamily) : "inherit";
}

function getUniqueFontFamilies(fontFamilies: string[]): string[] {
  const seen = new Set<string>();
  const uniqueFontFamilies: string[] = [];

  for (const fontFamily of fontFamilies) {
    const trimmedFontFamily = fontFamily.trim();
    const normalizedFontFamily = trimmedFontFamily.toLocaleLowerCase();
    if (!trimmedFontFamily || seen.has(normalizedFontFamily)) {
      continue;
    }

    seen.add(normalizedFontFamily);
    uniqueFontFamilies.push(trimmedFontFamily);
  }

  return uniqueFontFamilies.sort((a, b) => a.localeCompare(b));
}

async function getInstalledFontFamilies(): Promise<string[]> {
  const fontAccessApi = window as Window & {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  };

  if (typeof fontAccessApi.queryLocalFonts !== "function") {
    return [];
  }

  try {
    const localFonts = await fontAccessApi.queryLocalFonts();
    return getUniqueFontFamilies(localFonts.map((font) => font.family));
  } catch {
    return [];
  }
}

function enableMarkdownListContinuation(textarea: HTMLTextAreaElement) {
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const currentLine = value.slice(lineStart, start);
    const match = currentLine.match(/^(\s*)((?:[-*+]\s+\[[ xX]\]\s+)|(?:[-*+]\s+)|(?:\d+[.)]\s+))(.*)$/);

    if (!match) {
      return;
    }

    event.preventDefault();

    const indent = match[1];
    const marker = match[2];
    const content = match[3];

    if (content.trim().length === 0) {
      replaceTextareaRange(textarea, lineStart, start, indent);
      return;
    }

    replaceTextareaRange(textarea, start, end, `\n${indent}${getNextListMarker(marker)}`);
  });
}

function getNextListMarker(marker: string): string {
  const numbered = marker.match(/^(\d+)([.)])\s+$/);
  if (numbered) {
    return `${Number(numbered[1]) + 1}${numbered[2]} `;
  }

  const checkbox = marker.match(/^([-*+]\s+)\[[ xX]\]\s+$/);
  if (checkbox) {
    return `${checkbox[1]}[ ] `;
  }

  return marker;
}

function replaceTextareaRange(textarea: HTMLTextAreaElement, start: number, end: number, replacement: string) {
  textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
  const cursor = start + replacement.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  textarea.focus();
  textarea.dispatchEvent(new Event("input"));
}

function wrapSelection(textarea: HTMLTextAreaElement, before: string, after: string) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);

  textarea.value =
    textarea.value.slice(0, start) +
    before +
    selected +
    after +
    textarea.value.slice(end);

  textarea.selectionStart = start + before.length;
  textarea.selectionEnd = end + before.length;
  textarea.focus();
  textarea.dispatchEvent(new Event("input"));
}

function applyLinePrefix(textarea: HTMLTextAreaElement, prefix: string) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end);
  const selectionEnd = lineEnd === -1 ? value.length : lineEnd;
  const selectedBlock = value.slice(lineStart, selectionEnd);
  const lines = selectedBlock.split("\n");
  const prefixed = lines.map((line) => (line.trim().length > 0 ? `${prefix}${line}` : line)).join("\n");

  textarea.value = value.slice(0, lineStart) + prefixed + value.slice(selectionEnd);
  textarea.selectionStart = lineStart;
  textarea.selectionEnd = lineStart + prefixed.length;
  textarea.focus();
  textarea.dispatchEvent(new Event("input"));
}

function createBlockIdHiderExtension(prefix: string, protectBlockIds: boolean) {
  const safePrefix = escapeRegExp(sanitizeBlockPrefix(prefix));
  const blockIdRegex = new RegExp(`[ \\t\\u00a0]*\\^${safePrefix}-[^\\r\\n]*(?=\\s*$)`, "gm");

  const hider = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildBlockIdDecorations(view, blockIdRegex);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildBlockIdDecorations(update.view, blockIdRegex);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
    }
  );

  const protector = EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged) {
      return transaction;
    }

    const protectedRanges = getProtectedBlockIdRanges(transaction.startState.doc, blockIdRegex);
    if (protectedRanges.length === 0) {
      return transaction;
    }

    const redirectedChanges: Array<{ from: number; to: number; insert: Text | string }> = [];
    let redirectedSelectionAnchor: number | null = null;
    const hasSelection = transaction.startState.selection.ranges.some((range) => !range.empty);
    let blockChange = false;

    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (inserted.length === 0 && fromA < toA) {
        const touchedRanges = protectedRanges.filter((range) => changeTouchesProtectedRange(fromA, toA, range));
        if (touchedRanges.length > 0) {
          if (hasSelection && touchedRanges.every((range) => fromA <= range.from && toA >= range.to)) {
            return;
          }

          for (const deletionRange of getUnprotectedDeletionRanges(fromA, toA, protectedRanges)) {
            redirectedChanges.push({
              from: deletionRange.from,
              to: deletionRange.to,
              insert: inserted
            });
          }
          return;
        }
      }

      const standaloneRangeMove = getStandaloneProtectedRangeMoveAfterParagraphBreak(
        transaction.startState.doc,
        fromA,
        toA,
        inserted,
        protectedRanges
      );
      if (standaloneRangeMove) {
        redirectedChanges.push(...standaloneRangeMove.changes);
        redirectedSelectionAnchor = standaloneRangeMove.selectionAnchor;
        return;
      }

      const redirectedRange = protectedRanges.find((range) =>
        changeCanBeRedirectedAroundProtectedRange(fromA, toA, inserted, range)
      );

      if (redirectedRange) {
        const insertAt = getProtectedRangeInsertPosition(inserted, redirectedRange);
        redirectedChanges.push({
          from: insertAt,
          to: insertAt,
          insert: inserted
        });
        return;
      }

      if (changeTouchesProtectedRanges(fromA, toA, protectedRanges)) {
        blockChange = true;
      }
    });

    if (blockChange) {
      return [];
    }

    if (redirectedChanges.length > 0) {
      const lastChange = redirectedChanges[redirectedChanges.length - 1];
      return {
        changes: redirectedChanges,
        selection: { anchor: redirectedSelectionAnchor ?? lastChange.from + lastChange.insert.length },
        scrollIntoView: transaction.scrollIntoView
      };
    }

    return transaction;
  });

  return protectBlockIds ? [hider, protector] : [hider];
}

function buildBlockIdDecorations(view: EditorView, blockIdRegex: RegExp): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const range of view.visibleRanges) {
    const text = view.state.doc.sliceString(range.from, range.to);
    blockIdRegex.lastIndex = 0;

    for (let match = blockIdRegex.exec(text); match; match = blockIdRegex.exec(text)) {
      const from = range.from + match.index;
      const to = from + match[0].length;
      builder.add(from, to, Decoration.replace({ inclusive: true }));
    }
  }

  return builder.finish();
}

function getProtectedBlockIdRanges(doc: Text, blockIdRegex: RegExp): Array<{ from: number; to: number }> {
  const text = doc.toString();
  const ranges: Array<{ from: number; to: number }> = [];
  blockIdRegex.lastIndex = 0;

  for (let match = blockIdRegex.exec(text); match; match = blockIdRegex.exec(text)) {
    ranges.push({
      from: match.index,
      to: match.index + match[0].length
    });
  }

  return ranges;
}

function changeTouchesProtectedRanges(from: number, to: number, ranges: Array<{ from: number; to: number }>): boolean {
  return ranges.some((range) => changeTouchesProtectedRange(from, to, range));
}

function changeTouchesProtectedRange(from: number, to: number, range: { from: number; to: number }): boolean {
  if (from === to) {
    return from > range.from && from <= range.to;
  }

  return from < range.to && to > range.from;
}

function getUnprotectedDeletionRanges(from: number, to: number, protectedRanges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const deletionRanges: Array<{ from: number; to: number }> = [];
  let cursor = from;

  for (const range of protectedRanges) {
    if (range.to <= cursor || range.from >= to) {
      continue;
    }

    if (cursor < range.from) {
      deletionRanges.push({
        from: cursor,
        to: Math.min(range.from, to)
      });
    }

    cursor = Math.max(cursor, range.to);
  }

  if (cursor < to) {
    deletionRanges.push({ from: cursor, to });
  }

  return deletionRanges.filter((range) => range.from < range.to);
}

function getStandaloneProtectedRangeMoveAfterParagraphBreak(
  doc: Text,
  from: number,
  to: number,
  inserted: Text,
  protectedRanges: Array<{ from: number; to: number }>
): { changes: Array<{ from: number; to: number; insert: Text | string }>; selectionAnchor: number } | null {
  const insertedText = inserted.toString();
  if (from !== to || !insertedText.includes("\n")) {
    return null;
  }

  const protectedRange = protectedRanges.find((range) => from === range.from);
  if (!protectedRange) {
    return null;
  }

  const currentLine = doc.lineAt(protectedRange.from);
  const textBeforeBlockId = doc.sliceString(currentLine.from, protectedRange.from);
  const textAfterBlockId = doc.sliceString(protectedRange.to, currentLine.to);
  if (textBeforeBlockId.trim().length > 0 || textAfterBlockId.trim().length > 0 || currentLine.from === 0) {
    return null;
  }

  const previousLine = doc.lineAt(currentLine.from - 1);
  const previousLineText = doc.sliceString(previousLine.from, previousLine.to);
  if (previousLineText.trim().length === 0 || isFenceLine(previousLineText)) {
    return null;
  }

  const protectedText = doc.sliceString(protectedRange.from, protectedRange.to);
  const existingLineBreakLength = currentLine.from - previousLine.to;
  return {
    changes: [
      {
        from: previousLine.to,
        to: previousLine.to,
        insert: `${protectedText}${insertedText}`
      },
      {
        from: protectedRange.from,
        to: protectedRange.to,
        insert: ""
      }
    ],
    selectionAnchor: previousLine.to + protectedText.length + insertedText.length + existingLineBreakLength
  };
}

function changeCanBeRedirectedAroundProtectedRange(from: number, to: number, inserted: Text, range: { from: number; to: number }): boolean {
  if (inserted.length === 0) {
    return false;
  }

  if (from === to && (from === range.from || from === range.to)) {
    return true;
  }

  return from >= range.from && to <= range.to;
}

function getProtectedRangeInsertPosition(inserted: Text, range: { from: number; to: number }): number {
  return range.from;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
