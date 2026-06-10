import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { filterAssembly, type AssemblyFilterOptions } from "./assemblyFilters";
import {
  chooseInferredCompileCommandPath,
  parseCompilationCommand,
  parseCompileFlagsText,
  sameFsPath,
  sanitizeCompileCommandArgs
} from "./compileCommands";

const assemblyScheme = "godbolt-lite";
const maxCompileCommandsBytes = 50 * 1024 * 1024;
const maxCompileFlagsBytes = 1024 * 1024;
const forceKillDelayMs = 500;
const selectCompilerAction = "Select Compiler...";

type AssemblyFilterId = "trimMetadataDirectives" | "trimComments" | "trimBlankLines";

type AssemblyFilterOption = {
  readonly id: AssemblyFilterId;
  readonly setting: string;
  readonly label: string;
  readonly description: string;
};

type CompileResult = {
  readonly ok: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly commandLine: string;
  readonly elapsedMs: number;
  readonly truncated: boolean;
};

type CompileInput = {
  readonly compilerPath: string;
  readonly args: string[];
  readonly cwd: string;
  readonly inputPath: string;
  readonly displayPath: string;
  readonly compilationDatabasePath?: string;
  readonly compileFlagsPath?: string;
  readonly cleanupDir?: string;
};

type RunningCompile = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stop: () => void;
};

type DiagnosticBucket = {
  readonly uri: vscode.Uri;
  readonly diagnostics: vscode.Diagnostic[];
};

type CompileCommandEntry = {
  readonly directory: string;
  readonly file: string;
  readonly arguments?: string[];
  readonly command?: string;
};

type CompileCommandMatch = {
  readonly databasePath: string;
  readonly directory: string;
  readonly filePath: string;
  readonly argv: string[];
};

type CachedCompilationDatabase = {
  readonly mtimeMs: number;
  readonly entries: CompileCommandEntry[];
};

type CompileFlagsMatch = {
  readonly flagsPath: string;
  readonly directory: string;
  readonly flags: string[];
};

type CachedCompileFlags = {
  readonly mtimeMs: number;
  readonly flags: string[];
};

type GodboltLiteConfig = ReturnType<typeof getConfig>;

class AssemblyContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly contents = new Map<string, string>();

  readonly onDidChange = this.changeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? loadingContent("Waiting for compilation...");
  }

  update(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.changeEmitter.fire(uri);
  }

  delete(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
    this.changeEmitter.fire(uri);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

class AssemblyDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const sourceUri = document.uri.query ? vscode.Uri.parse(document.uri.query) : undefined;
    const sourceLink = sourceUri ? documentLinkForPrefix(document, "# Source: ", sourceUri) : undefined;
    if (sourceLink) links.push(sourceLink);

    for (const prefix of ["# Compilation database: ", "# Compile flags: "]) {
      const metadataLink = metadataDocumentLinkForPrefix(document, prefix);
      if (metadataLink) links.push(metadataLink);
    }

    return links;
  }
}

class SourceCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isSupportedDocument(document) || !sourceCodeLensEnabled(document)) return [];
    const hasAssembly = hasAssemblyDocument(document);
    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: hasAssembly ? "Refresh Assembly" : "Open Assembly",
        command: hasAssembly ? "godboltLite.refreshAssembly" : "godboltLite.openAssembly",
        arguments: [document.uri]
      })
    ];
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

let provider: AssemblyContentProvider;
let sourceCodeLensProvider: SourceCodeLensProvider | undefined;
let outputChannel: vscode.OutputChannel;
let diagnosticCollection: vscode.DiagnosticCollection;
let statusBar: vscode.StatusBarItem;
const pendingCompilesBySource = new Map<string, NodeJS.Timeout>();
const runningCompilesBySource = new Map<string, RunningCompile>();
const compileGenerationsBySource = new Map<string, number>();
const assemblyUrisBySource = new Map<string, vscode.Uri>();
const diagnosticsBySource = new Map<string, Map<string, DiagnosticBucket>>();
const compileCommandsCache = new Map<string, CachedCompilationDatabase>();
const compileFlagsCache = new Map<string, CachedCompileFlags>();
const suppressedAutoCompileSourceKeys = new Set<string>();
const compilerSelectionPromptsBySource = new Set<string>();
let configuredMetadataWatchers = vscode.Disposable.from();

const assemblyFilterOptions: readonly AssemblyFilterOption[] = [
  {
    id: "trimMetadataDirectives",
    setting: "filters.trimMetadataDirectives",
    label: "Hide metadata directives",
    description: ".file, .loc, .cfi_*, .debug_*, .ident"
  },
  {
    id: "trimComments",
    setting: "filters.trimComments",
    label: "Hide assembly comments",
    description: "Leave instructions and labels visible"
  },
  {
    id: "trimBlankLines",
    setting: "filters.trimBlankLines",
    label: "Collapse blank lines",
    description: "Keep assembly output compact"
  }
];

export function activate(context: vscode.ExtensionContext): void {
  provider = new AssemblyContentProvider();
  sourceCodeLensProvider = new SourceCodeLensProvider();
  outputChannel = vscode.window.createOutputChannel("Godbolt Lite");
  diagnosticCollection = vscode.languages.createDiagnosticCollection("godbolt-lite");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = "godboltLite.compile";
  statusBar.text = "$(zap) Godbolt Lite";
  statusBar.tooltip = "Compile active C/C++ file to assembly";
  rebuildConfiguredMetadataWatchers();

  context.subscriptions.push(
    provider,
    outputChannel,
    diagnosticCollection,
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(assemblyScheme, provider),
    vscode.languages.registerDocumentLinkProvider({ scheme: assemblyScheme }, new AssemblyDocumentLinkProvider()),
    sourceCodeLensProvider,
    vscode.languages.registerCodeLensProvider([{ language: "c" }, { language: "cpp" }], sourceCodeLensProvider),
    ...buildMetadataWatchers(),
    new vscode.Disposable(() => configuredMetadataWatchers.dispose()),
    vscode.commands.registerCommand("godboltLite.openAssembly", (target?: unknown) => openAssembly(target)),
    vscode.commands.registerCommand("godboltLite.compile", (target?: unknown) => compileCommandTarget(target)),
    vscode.commands.registerCommand("godboltLite.refreshAssembly", (target?: unknown) => compileCommandTarget(target)),
    vscode.commands.registerCommand("godboltLite.openSource", (target?: unknown) => openSource(target)),
    vscode.commands.registerCommand("godboltLite.copyAssembly", (target?: unknown) => copyAssembly(target)),
    vscode.commands.registerCommand("godboltLite.copyCompilerCommand", (target?: unknown) => copyCompilerCommand(target)),
    vscode.commands.registerCommand("godboltLite.showOutput", () => outputChannel.show(true)),
    vscode.commands.registerCommand("godboltLite.saveAssembly", (target?: unknown, saveUri?: unknown) => saveAssembly(target, saveUri)),
    vscode.commands.registerCommand("godboltLite.configureAssemblyFilters", (
      target?: unknown,
      selectedFilters?: unknown
    ) => configureAssemblyFilters(target, selectedFilters)),
    vscode.commands.registerCommand("godboltLite.selectCompiler", (
      target?: unknown,
      selectedCompiler?: unknown
    ) => selectCompiler(target, selectedCompiler)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !shouldAutoCompile(editor.document)) return;
      if (consumeSuppressedAutoCompile(editor.document)) return;
      scheduleCompile(editor.document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!shouldAutoCompile(event.document)) return;
      scheduleCompile(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!shouldAutoCompile(document)) return;
      scheduleCompile(document, 0);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme !== assemblyScheme) return;
      provider.delete(document.uri);
      removeAssemblyUri(document.uri);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => rebuildConfiguredMetadataWatchers()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("godboltLite.codeLens.enabled")) {
        sourceCodeLensProvider?.refresh();
      }
      if (
        event.affectsConfiguration("godboltLite.compileCommandsPath") ||
        event.affectsConfiguration("godboltLite.compileFlagsPath")
      ) {
        rebuildConfiguredMetadataWatchers();
      }
      if (!event.affectsConfiguration("godboltLite")) return;
      if (!configurationChangeAffectsAssembly(event)) return;
      recompileAffectedAssemblyDocuments(event);
    })
  );
}

export function deactivate(): void {
  for (const timer of pendingCompilesBySource.values()) clearTimeout(timer);
  pendingCompilesBySource.clear();
  for (const sourceUri of runningCompilesBySource.keys()) cancelRunningCompile(sourceUri);
}

async function openAssembly(target?: unknown): Promise<void> {
  const document = await sourceDocumentForCommandTarget(target);
  if (!document) {
    void vscode.window.showInformationMessage("Open a C or C++ file before opening Godbolt Lite.");
    return;
  }

  const uri = assemblyUriFor(document);
  sourceCodeLensProvider?.refresh();
  provider.update(uri, loadingContent(`Compiling ${document.fileName}...`));
  await revealSourceDocument(document);
  const assemblyDocument = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(assemblyDocument, "asm").then(
    (asmDocument) => vscode.window.showTextDocument(asmDocument, vscode.ViewColumn.Beside, false),
    () => vscode.window.showTextDocument(assemblyDocument, vscode.ViewColumn.Beside, false)
  );
  await compileDocument(document);
}

async function compileCommandTarget(target?: unknown): Promise<void> {
  const document = await sourceDocumentForCommandTarget(target);
  if (!document) {
    void vscode.window.showInformationMessage("Open a C or C++ file before compiling with Godbolt Lite.");
    return;
  }

  if (!hasAssemblyDocument(document)) {
    await openAssembly(document.uri);
    return;
  }
  await compileDocument(document);
}

async function openSource(target?: unknown): Promise<void> {
  const document = await sourceDocumentForCommandTarget(target);
  if (!document) {
    void vscode.window.showInformationMessage("Open a Godbolt Lite assembly document before opening its source.");
    return;
  }

  await revealSourceDocument(document);
}

async function copyAssembly(target?: unknown): Promise<void> {
  const document = await assemblyDocumentForCommandTarget(target);
  if (!document) {
    void vscode.window.showInformationMessage("Open a Godbolt Lite assembly document before copying assembly.");
    return;
  }

  await vscode.env.clipboard.writeText(document.getText());
  void vscode.window.showInformationMessage("Copied Godbolt Lite assembly to the clipboard.");
}

async function copyCompilerCommand(target?: unknown): Promise<void> {
  const document = await assemblyDocumentForCommandTarget(target);
  if (!document) {
    void vscode.window.showInformationMessage("Open a Godbolt Lite assembly document before copying its compiler command.");
    return;
  }

  const commandLine = compilerCommandFromAssemblyText(document.getText());
  if (!commandLine) {
    void vscode.window.showInformationMessage("The current Godbolt Lite assembly document does not contain a compiler command.");
    return;
  }

  await vscode.env.clipboard.writeText(commandLine);
  void vscode.window.showInformationMessage("Copied Godbolt Lite compiler command to the clipboard.");
}

async function saveAssembly(target?: unknown, saveTarget?: unknown): Promise<void> {
  const document = await assemblyDocumentForCommandTarget(target);
  if (!document) {
    void vscode.window.showInformationMessage("Open a Godbolt Lite assembly document before saving assembly.");
    return;
  }

  const destination = saveTarget instanceof vscode.Uri ? saveTarget : await promptForAssemblySaveUri(document);
  if (!destination) return;

  await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(document.getText()));
  void vscode.window.showInformationMessage(`Saved Godbolt Lite assembly to ${destination.fsPath || destination.toString()}.`);
}

async function configureAssemblyFilters(target?: unknown, selectedFilters?: unknown): Promise<void> {
  const document = await sourceDocumentForCommandTarget(target);
  if (!document) {
    void vscode.window.showInformationMessage("Open a Godbolt Lite assembly document before configuring assembly filters.");
    return;
  }

  const section = vscode.workspace.getConfiguration("godboltLite", document.uri);
  const current = getConfig(document.uri).assemblyFilters;
  const selected = filterSelectionFromCommandArg(selectedFilters) ?? await promptForAssemblyFilters(current);
  if (!selected) return;

  let changed = false;
  for (const option of assemblyFilterOptions) {
    const enabled = selected.has(option.id);
    if (current[option.id] === enabled) continue;
    changed = true;
    await section.update(option.setting, enabled, configurationTargetForSetting(section, option.setting));
  }

  if (changed) {
    void vscode.window.showInformationMessage("Updated Godbolt Lite assembly filters.");
  } else {
    void vscode.window.showInformationMessage("Godbolt Lite assembly filters are already up to date.");
  }
}

async function selectCompiler(target?: unknown, selectedCompiler?: unknown): Promise<void> {
  const resource = sourceUriForCommandResource(commandTargetUri(target) ?? vscode.window.activeTextEditor?.document.uri);
  const compilerUri = selectedCompiler instanceof vscode.Uri ? selectedCompiler : await promptForCompilerUri(resource);
  if (!compilerUri) return;

  if (compilerUri.scheme !== "file") {
    void vscode.window.showErrorMessage("Select a compiler executable from a file system path.");
    return;
  }

  const compilerPath = compilerUri.fsPath || compilerUri.path;
  if (!compilerPath) {
    void vscode.window.showErrorMessage("Selected compiler path is empty.");
    return;
  }

  const section = vscode.workspace.getConfiguration("godboltLite", resource);
  await section.update("compilerPath", compilerPath, configurationTargetForSetting(section, "compilerPath"));
  void vscode.window.showInformationMessage(`Set Godbolt Lite compiler to ${compilerPath}.`);
}

function scheduleCompile(document: vscode.TextDocument, delayOverride?: number): void {
  const sourceKey = document.uri.toString();
  const existing = pendingCompilesBySource.get(sourceKey);
  if (existing) clearTimeout(existing);
  const delayMs = delayOverride ?? getConfig(document.uri).debounceMs;
  const timer = setTimeout(() => {
    pendingCompilesBySource.delete(sourceKey);
    void compileDocument(document);
  }, delayMs);
  pendingCompilesBySource.set(sourceKey, timer);
}

async function compileDocument(document: vscode.TextDocument): Promise<void> {
  if (!isSupportedDocument(document)) return;

  const sourceKey = document.uri.toString();
  const generation = (compileGenerationsBySource.get(sourceKey) ?? 0) + 1;
  compileGenerationsBySource.set(sourceKey, generation);
  cancelRunningCompile(sourceKey);
  const uri = assemblyUriFor(document);
  const title = path.basename(document.fileName);
  provider.update(uri, loadingContent(`Compiling ${document.fileName}...`));
  setStatus(`$(sync~spin) Godbolt Lite: ${title}`);

  let input: CompileInput | undefined;
  try {
    const config = getConfig(document.uri);
    input = await prepareCompileInput(document, config);
    const result = await runCompiler(sourceKey, input, config.timeoutMs, config.maxOutputBytes);
    if (generation !== compileGenerationsBySource.get(sourceKey)) return;
    const content = renderCompileResult(document, input, result, config.assemblyFilters);
    provider.update(uri, content);
    updateDiagnostics(document, input, result.stderr, config.showDiagnostics);
    writeCompilerOutput(document, result);
    setStatus(result.ok ? `$(check) Godbolt Lite: ${title}` : `$(warning) Godbolt Lite: ${title}`);
  } catch (error) {
    if (generation !== compileGenerationsBySource.get(sourceKey)) return;
    const message = error instanceof Error ? error.message : String(error);
    provider.update(uri, renderError(document, message));
    clearDiagnosticsForSource(sourceKey);
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${document.fileName}`);
    outputChannel.appendLine(message);
    setStatus(`$(error) Godbolt Lite: ${title}`);
    if (error instanceof CompilerStartError) {
      void offerCompilerSelection(document.uri, message);
    }
  } finally {
    if (input?.cleanupDir) {
      await fs.rm(input.cleanupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function prepareCompileInput(document: vscode.TextDocument, config: GodboltLiteConfig): Promise<CompileInput> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const documentDir = document.uri.scheme === "file" ? path.dirname(document.uri.fsPath) : workspaceFolder?.uri.fsPath;
  const compileCommand = config.useCompileCommands
    ? await findCompileCommand(document, config.compileCommandsPath, config.inferHeaderCompileCommand)
    : undefined;
  const compileFlags = !compileCommand && config.useCompileFlags ? await findCompileFlags(document, config.compileFlagsPath) : undefined;
  const compilerPath = config.compilerPath || compileCommand?.argv[0] || defaultCompilerFor(document);
  const cwd = compileCommand?.directory ?? compileFlags?.directory ?? workspaceFolder?.uri.fsPath ?? documentDir ?? os.tmpdir();

  let inputPath: string;
  let cleanupDir: string | undefined;
  if (document.uri.scheme === "file" && !document.isDirty) {
    inputPath = document.uri.fsPath;
  } else {
    const temp = await writeDocumentToTempFile(document);
    inputPath = temp.filePath;
    cleanupDir = temp.dir;
  }

  const sourceDirectoryArgs = cleanupDir && documentDir ? ["-I", documentDir] : [];
  const configuredArgs = compileCommand
    ? sanitizeCompileCommandArgs(compileCommand.argv, compileCommand.filePath, compileCommand.directory)
    : compileFlags?.flags ?? config.compilerArgs;
  const args = [
    ...configuredArgs,
    ...(compileCommand || compileFlags ? config.extraCompilerArgs : []),
    "-S",
    "-o",
    "-",
    "-x",
    compilerLanguage(document),
    ...(compileCommand ? sourceDirectoryArgs : includeArgs(documentDir, workspaceFolder?.uri.fsPath, config.includeWorkspaceFolder)),
    inputPath
  ];

  return {
    compilerPath,
    args,
    cwd,
    inputPath,
    displayPath: document.uri.scheme === "file" ? document.uri.fsPath : document.fileName,
    compilationDatabasePath: compileCommand?.databasePath,
    compileFlagsPath: compileFlags?.flagsPath,
    cleanupDir
  };
}

async function writeDocumentToTempFile(document: vscode.TextDocument): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-"));
  const filePath = path.join(dir, `input${extensionForDocument(document)}`);
  await fs.writeFile(filePath, document.getText(), "utf8");
  return { dir, filePath };
}

function includeArgs(documentDir: string | undefined, workspaceDir: string | undefined, includeWorkspace: boolean): string[] {
  const dirs = new Set<string>();
  if (documentDir) dirs.add(documentDir);
  if (includeWorkspace && workspaceDir) dirs.add(workspaceDir);
  return [...dirs].flatMap((dir) => ["-I", dir]);
}

async function findCompileCommand(
  document: vscode.TextDocument,
  configuredPath: string,
  inferHeaderCompileCommand: boolean
): Promise<CompileCommandMatch | undefined> {
  if (document.uri.scheme !== "file") return undefined;
  const candidates = compileCommandsCandidates(document, configuredPath);
  for (const databasePath of candidates) {
    const entries = await readCompilationDatabase(databasePath);
    if (!entries) continue;
    const match = matchCompileCommandEntry(entries, databasePath, document.uri.fsPath, inferHeaderCompileCommand);
    if (match) return match;
  }
  return undefined;
}

async function findCompileFlags(
  document: vscode.TextDocument,
  configuredPath: string
): Promise<CompileFlagsMatch | undefined> {
  if (document.uri.scheme !== "file") return undefined;
  for (const flagsPath of compileFlagsCandidates(document, configuredPath)) {
    const flags = await readCompileFlags(flagsPath);
    if (!flags) continue;
    return {
      flagsPath,
      directory: path.dirname(flagsPath),
      flags
    };
  }
  return undefined;
}

function compileCommandsCandidates(document: vscode.TextDocument, configuredPath: string): string[] {
  const candidates: string[] = [];
  const addCandidate = (candidate: string) => {
    const normalized = path.normalize(candidate);
    if (!candidates.some((existing) => sameFsPath(existing, normalized))) candidates.push(normalized);
  };

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceDir = workspaceFolder?.uri.fsPath;
  if (configuredPath.trim()) {
    const configured = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(workspaceDir ?? path.dirname(document.uri.fsPath), configuredPath);
    addCandidate(configured.endsWith(".json") ? configured : path.join(configured, "compile_commands.json"));
    return candidates;
  }

  const stopDir = workspaceDir ? path.resolve(workspaceDir) : path.parse(document.uri.fsPath).root;
  let current = path.dirname(document.uri.fsPath);
  while (true) {
    addCandidate(path.join(current, "compile_commands.json"));
    addCandidate(path.join(current, "build", "compile_commands.json"));
    if (sameFsPath(current, stopDir)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

function compileFlagsCandidates(document: vscode.TextDocument, configuredPath: string): string[] {
  const candidates: string[] = [];
  const addCandidate = (candidate: string) => {
    const normalized = path.normalize(candidate);
    if (!candidates.some((existing) => sameFsPath(existing, normalized))) candidates.push(normalized);
  };

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceDir = workspaceFolder?.uri.fsPath;
  if (configuredPath.trim()) {
    const configured = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(workspaceDir ?? path.dirname(document.uri.fsPath), configuredPath);
    addCandidate(configured.endsWith(".txt") ? configured : path.join(configured, "compile_flags.txt"));
    return candidates;
  }

  const stopDir = workspaceDir ? path.resolve(workspaceDir) : path.parse(document.uri.fsPath).root;
  let current = path.dirname(document.uri.fsPath);
  while (true) {
    addCandidate(path.join(current, "compile_flags.txt"));
    if (sameFsPath(current, stopDir)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

async function readCompilationDatabase(databasePath: string): Promise<CompileCommandEntry[] | undefined> {
  try {
    const stat = await fs.stat(databasePath);
    if (!stat.isFile() || stat.size > maxCompileCommandsBytes) return undefined;
    const cached = compileCommandsCache.get(databasePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entries;
    const text = await fs.readFile(databasePath, "utf8");
    const raw = JSON.parse(text) as unknown;
    if (!Array.isArray(raw)) return undefined;
    const entries = raw.flatMap((item) => parseCompileCommandEntry(item));
    compileCommandsCache.set(databasePath, { mtimeMs: stat.mtimeMs, entries });
    return entries;
  } catch {
    return undefined;
  }
}

async function readCompileFlags(flagsPath: string): Promise<string[] | undefined> {
  try {
    const stat = await fs.stat(flagsPath);
    if (!stat.isFile() || stat.size > maxCompileFlagsBytes) return undefined;
    const cached = compileFlagsCache.get(flagsPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.flags;
    const text = await fs.readFile(flagsPath, "utf8");
    const flags = parseCompileFlagsText(text);
    compileFlagsCache.set(flagsPath, { mtimeMs: stat.mtimeMs, flags });
    return flags;
  } catch {
    return undefined;
  }
}

function buildMetadataWatchers(): vscode.Disposable[] {
  return [
    buildMetadataWatcher("compile_commands.json", compileCommandsCache),
    buildMetadataWatcher("compile_flags.txt", compileFlagsCache)
  ];
}

function buildMetadataWatcher(fileName: string, cache: Map<string, unknown>): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${fileName}`);
  const onChange = (uri: vscode.Uri) => {
    deleteCachedPath(cache, uri.fsPath);
    recompileOpenAssemblyDocuments();
  };
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    watcher.onDidDelete(onChange)
  );
}

function rebuildConfiguredMetadataWatchers(): void {
  configuredMetadataWatchers.dispose();
  configuredMetadataWatchers = vscode.Disposable.from(...buildConfiguredMetadataWatchers());
}

function buildConfiguredMetadataWatchers(): vscode.Disposable[] {
  const watchers: vscode.Disposable[] = [];
  const seenPaths: string[] = [];
  for (const resource of configurationResources()) {
    const baseDir = resource?.fsPath;
    const section = vscode.workspace.getConfiguration("godboltLite", resource);
    addConfiguredMetadataWatcher(
      watchers,
      seenPaths,
      section.get<string>("compileCommandsPath", ""),
      "compile_commands.json",
      ".json",
      compileCommandsCache,
      baseDir
    );
    addConfiguredMetadataWatcher(
      watchers,
      seenPaths,
      section.get<string>("compileFlagsPath", ""),
      "compile_flags.txt",
      ".txt",
      compileFlagsCache,
      baseDir
    );
  }
  return watchers;
}

function configurationResources(): Array<vscode.Uri | undefined> {
  return [
    undefined,
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)
  ];
}

function addConfiguredMetadataWatcher(
  watchers: vscode.Disposable[],
  seenPaths: string[],
  configuredPath: string,
  fileName: string,
  fileExtension: string,
  cache: Map<string, unknown>,
  baseDir: string | undefined
): void {
  const metadataPath = configuredMetadataPath(configuredPath, fileName, fileExtension, baseDir);
  if (!metadataPath || seenPaths.some((seen) => sameFsPath(seen, metadataPath))) return;
  seenPaths.push(metadataPath);
  watchers.push(buildExactMetadataWatcher(metadataPath, cache));
}

function configuredMetadataPath(
  configuredPath: string,
  fileName: string,
  fileExtension: string,
  baseDir: string | undefined
): string | undefined {
  const trimmed = configuredPath.trim();
  if (!trimmed) return undefined;
  const resolved = path.isAbsolute(trimmed) ? trimmed : resolveRelativeConfiguredPath(trimmed, baseDir);
  if (!resolved) return undefined;
  return path.normalize(resolved.endsWith(fileExtension) ? resolved : path.join(resolved, fileName));
}

function resolveRelativeConfiguredPath(configuredPath: string, baseDir: string | undefined): string | undefined {
  return baseDir ? path.resolve(baseDir, configuredPath) : undefined;
}

function buildExactMetadataWatcher(metadataPath: string, cache: Map<string, unknown>): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.dirname(metadataPath), path.basename(metadataPath))
  );
  const onChange = () => {
    deleteCachedPath(cache, metadataPath);
    recompileOpenAssemblyDocuments();
  };
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    watcher.onDidDelete(onChange)
  );
}

function deleteCachedPath(cache: Map<string, unknown>, filePath: string): void {
  for (const key of cache.keys()) {
    if (sameFsPath(key, filePath)) {
      cache.delete(key);
    }
  }
}

function parseCompileCommandEntry(item: unknown): CompileCommandEntry[] {
  if (!item || typeof item !== "object") return [];
  const record = item as Record<string, unknown>;
  if (typeof record.directory !== "string" || typeof record.file !== "string") return [];
  const entry: CompileCommandEntry = {
    directory: record.directory,
    file: record.file,
    arguments: Array.isArray(record.arguments) && record.arguments.every((arg) => typeof arg === "string")
      ? record.arguments
      : undefined,
    command: typeof record.command === "string" ? record.command : undefined
  };
  if (!entry.arguments && !entry.command) return [];
  return [entry];
}

function matchCompileCommandEntry(
  entries: CompileCommandEntry[],
  databasePath: string,
  sourcePath: string,
  inferHeaderCompileCommand: boolean
): CompileCommandMatch | undefined {
  const parsedEntries = entries.flatMap((entry) => parsedCompileCommandEntry(entry, databasePath));
  const direct = parsedEntries.find((entry) => sameFsPath(entry.filePath, sourcePath));
  if (direct) return direct;
  if (!inferHeaderCompileCommand) return undefined;
  const inferredPath = chooseInferredCompileCommandPath(sourcePath, parsedEntries.map((entry) => entry.filePath));
  return inferredPath ? parsedEntries.find((entry) => sameFsPath(entry.filePath, inferredPath)) : undefined;
}

function parsedCompileCommandEntry(entry: CompileCommandEntry, databasePath: string): CompileCommandMatch[] {
  const directory = path.resolve(path.dirname(databasePath), entry.directory);
  const filePath = path.isAbsolute(entry.file) ? path.normalize(entry.file) : path.resolve(directory, entry.file);
  const argv = entry.arguments ?? parseCompilationCommand(entry.command ?? "");
  if (argv.length === 0) return [];
  return [{
    databasePath,
    directory,
    filePath,
    argv
  }];
}

function runCompiler(sourceKey: string, input: CompileInput, timeoutMs: number, maxOutputBytes: number): Promise<CompileResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(input.compilerPath, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const requestStop = () => {
      if (forceKillTimer) return;
      signalCompilerProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => signalCompilerProcess(child, "SIGKILL"), forceKillDelayMs);
      forceKillTimer.unref?.();
    };
    runningCompilesBySource.set(sourceKey, { child, stop: requestStop });

    const timer = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, timeoutMs);

    const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (truncated) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        truncated = true;
        const remaining = Math.max(0, maxOutputBytes - (outputBytes - chunk.byteLength));
        const text = chunk.subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += text;
        if (target === "stderr") stderr += text;
        stderr += `\n[Godbolt Lite truncated compiler output after ${maxOutputBytes} bytes]\n`;
        requestStop();
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      if (target === "stderr") stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (runningCompilesBySource.get(sourceKey)?.child === child) {
        runningCompilesBySource.delete(sourceKey);
      }
      reject(new CompilerStartError(input.compilerPath, error));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (runningCompilesBySource.get(sourceKey)?.child === child) {
        runningCompilesBySource.delete(sourceKey);
      }
      if (timedOut) {
        stderr += `\n[Godbolt Lite stopped the compiler after ${timeoutMs} ms]\n`;
      }
      resolve({
        ok: code === 0 && !timedOut && !truncated,
        code,
        signal,
        stdout,
        stderr,
        commandLine: formatCommandLine(input.compilerPath, input.args),
        elapsedMs: Date.now() - startedAt,
        truncated
      });
    });
  });
}

class CompilerStartError extends Error {
  constructor(compilerPath: string, cause: Error) {
    super(`Could not start compiler "${compilerPath}": ${cause.message}`, { cause });
    this.name = "CompilerStartError";
  }
}

async function offerCompilerSelection(resource: vscode.Uri, message: string): Promise<void> {
  const sourceKey = resource.toString();
  if (compilerSelectionPromptsBySource.has(sourceKey)) return;

  compilerSelectionPromptsBySource.add(sourceKey);
  try {
    const selected = await vscode.window.showErrorMessage(message, selectCompilerAction);
    if (selected === selectCompilerAction) {
      await selectCompiler(resource);
    }
  } finally {
    compilerSelectionPromptsBySource.delete(sourceKey);
  }
}

function signalCompilerProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", () => undefined);
      return;
    }
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function renderCompileResult(
  document: vscode.TextDocument,
  input: CompileInput,
  result: CompileResult,
  assemblyFilters: AssemblyFilterOptions
): string {
  const status = result.ok
    ? `compiled in ${result.elapsedMs} ms`
    : `compiler exited with ${result.code ?? result.signal ?? "error"}`;
  const diagnostics = result.stderr.trimEnd();
  const assembly = filterAssembly(result.stdout, assemblyFilters);
  return [
    `# Godbolt Lite: ${status}`,
    `# Source: ${document.fileName}`,
    input.compilationDatabasePath ? `# Compilation database: ${input.compilationDatabasePath}` : "",
    input.compileFlagsPath ? `# Compile flags: ${input.compileFlagsPath}` : "",
    `# Command: ${result.commandLine}`,
    diagnostics ? "\n# Diagnostics:\n" + commentBlock(diagnostics) : "",
    assembly ? "\n" + assembly : "\n# No assembly output."
  ].join("\n");
}

function renderError(document: vscode.TextDocument, message: string): string {
  return [
    "# Godbolt Lite: compilation failed",
    `# Source: ${document.fileName}`,
    "",
    commentBlock(message)
  ].join("\n");
}

function loadingContent(message: string): string {
  return `# Godbolt Lite\n# ${message}\n`;
}

function commentBlock(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => `# ${line}`)
    .join("\n");
}

function compilerCommandFromAssemblyText(text: string): string | undefined {
  const match = /^# Command:[^\S\r\n]*(\S.*)$/mu.exec(text);
  return match?.[1].trimEnd();
}

function metadataDocumentLinkForPrefix(document: vscode.TextDocument, prefix: string): vscode.DocumentLink | undefined {
  const value = documentValueForPrefix(document, prefix);
  if (!value) return undefined;
  return new vscode.DocumentLink(value.range, vscode.Uri.file(value.text));
}

function documentLinkForPrefix(
  document: vscode.TextDocument,
  prefix: string,
  target: vscode.Uri
): vscode.DocumentLink | undefined {
  const value = documentValueForPrefix(document, prefix);
  return value ? new vscode.DocumentLink(value.range, target) : undefined;
}

function documentValueForPrefix(
  document: vscode.TextDocument,
  prefix: string
): { readonly text: string; readonly range: vscode.Range } | undefined {
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const line = document.lineAt(lineNumber);
    if (!line.text.startsWith(prefix)) continue;
    const rawValue = line.text.slice(prefix.length);
    const text = rawValue.trim();
    if (!text) return undefined;
    const leadingWhitespace = rawValue.length - rawValue.trimStart().length;
    const trailingWhitespace = rawValue.length - rawValue.trimEnd().length;
    const start = prefix.length + leadingWhitespace;
    const end = line.text.length - trailingWhitespace;
    return {
      text,
      range: new vscode.Range(lineNumber, start, lineNumber, end)
    };
  }
  return undefined;
}

function writeCompilerOutput(document: vscode.TextDocument, result: CompileResult): void {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${document.fileName}`);
  outputChannel.appendLine(result.commandLine);
  outputChannel.appendLine(result.ok ? `ok (${result.elapsedMs} ms)` : `failed (${result.code ?? result.signal ?? "unknown"})`);
  if (result.stderr.trim()) {
    outputChannel.appendLine(result.stderr.trimEnd());
  }
  outputChannel.appendLine("");
}

function updateDiagnostics(
  document: vscode.TextDocument,
  input: CompileInput,
  stderr: string,
  showDiagnostics: boolean
): void {
  const sourceKey = document.uri.toString();
  if (!showDiagnostics || !stderr.trim()) {
    replaceDiagnosticsForSource(sourceKey, new Map());
    return;
  }

  const diagnosticsByUri = new Map<string, DiagnosticBucket>();
  for (const diagnostic of parseCompilerDiagnostics(document, input, stderr)) {
    const key = diagnostic.uri.toString();
    const existing = diagnosticsByUri.get(key);
    if (existing) {
      existing.diagnostics.push(diagnostic.diagnostic);
    } else {
      diagnosticsByUri.set(key, { uri: diagnostic.uri, diagnostics: [diagnostic.diagnostic] });
    }
  }
  replaceDiagnosticsForSource(sourceKey, diagnosticsByUri);
}

function replaceDiagnosticsForSource(sourceKey: string, diagnosticsByUri: Map<string, DiagnosticBucket>): void {
  const affectedUris = new Map<string, vscode.Uri>();
  const previous = diagnosticsBySource.get(sourceKey);
  if (previous) {
    for (const [key, entry] of previous) affectedUris.set(key, entry.uri);
  }
  for (const [key, entry] of diagnosticsByUri) affectedUris.set(key, entry.uri);

  if (diagnosticsByUri.size > 0) {
    diagnosticsBySource.set(sourceKey, diagnosticsByUri);
  } else {
    diagnosticsBySource.delete(sourceKey);
  }
  publishDiagnostics(affectedUris);
}

function publishDiagnostics(affectedUris: Map<string, vscode.Uri>): void {
  for (const [key, uri] of affectedUris) {
    const merged: vscode.Diagnostic[] = [];
    for (const diagnosticsByUri of diagnosticsBySource.values()) {
      const entry = diagnosticsByUri.get(key);
      if (entry) merged.push(...entry.diagnostics);
    }
    if (merged.length > 0) {
      diagnosticCollection.set(uri, merged);
    } else {
      diagnosticCollection.delete(uri);
    }
  }
}

function parseCompilerDiagnostics(
  document: vscode.TextDocument,
  input: CompileInput,
  stderr: string
): Array<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }> {
  const parsed: Array<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }> = [];
  const diagnosticPattern = /^(.+):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/u;
  for (const line of stderr.split(/\r?\n/u)) {
    const match = diagnosticPattern.exec(line);
    if (!match) continue;
    const [, rawFile, rawLine, rawColumn, rawSeverity, message] = match;
    if (rawFile.startsWith("<") && rawFile.endsWith(">")) continue;
    const uri = diagnosticUriFor(rawFile, document, input);
    const lineNumber = Math.max(0, Number.parseInt(rawLine, 10) - 1);
    const columnNumber = Math.max(0, Number.parseInt(rawColumn, 10) - 1);
    const range = diagnosticRange(uri, document, lineNumber, columnNumber);
    const diagnostic = new vscode.Diagnostic(range, message, diagnosticSeverity(rawSeverity));
    diagnostic.source = "Godbolt Lite";
    parsed.push({ uri, diagnostic });
  }
  return parsed;
}

function diagnosticUriFor(rawFile: string, document: vscode.TextDocument, input: CompileInput): vscode.Uri {
  const resolved = path.isAbsolute(rawFile) ? rawFile : path.resolve(input.cwd, rawFile);
  if (sameFsPath(resolved, input.inputPath) || sameFsPath(resolved, input.displayPath)) {
    return document.uri;
  }
  return vscode.Uri.file(resolved);
}

function diagnosticRange(uri: vscode.Uri, document: vscode.TextDocument, lineNumber: number, columnNumber: number): vscode.Range {
  if (uri.toString() !== document.uri.toString()) {
    return new vscode.Range(lineNumber, columnNumber, lineNumber, columnNumber + 1);
  }
  const safeLine = Math.min(lineNumber, Math.max(0, document.lineCount - 1));
  const line = document.lineAt(safeLine);
  const safeColumn = Math.min(columnNumber, line.text.length);
  return new vscode.Range(safeLine, safeColumn, safeLine, Math.min(line.text.length, safeColumn + 1));
}

function diagnosticSeverity(value: string): vscode.DiagnosticSeverity {
  if (value === "warning") return vscode.DiagnosticSeverity.Warning;
  if (value === "note") return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Error;
}

function clearDiagnosticsForSource(sourceUri: string): void {
  replaceDiagnosticsForSource(sourceUri, new Map());
}

async function revealSourceDocument(document: vscode.TextDocument): Promise<void> {
  const sourceKey = document.uri.toString();
  suppressedAutoCompileSourceKeys.add(sourceKey);
  try {
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false
    });
  } finally {
    setTimeout(() => suppressedAutoCompileSourceKeys.delete(sourceKey), 0);
  }
}

function consumeSuppressedAutoCompile(document: vscode.TextDocument): boolean {
  const sourceKey = document.uri.toString();
  if (!suppressedAutoCompileSourceKeys.has(sourceKey)) return false;
  suppressedAutoCompileSourceKeys.delete(sourceKey);
  return true;
}

function shouldAutoCompile(document: vscode.TextDocument): boolean {
  return isSupportedDocument(document) && hasAssemblyDocument(document) && getConfig(document.uri).autoCompile;
}

function sourceCodeLensEnabled(document: vscode.TextDocument): boolean {
  return vscode.workspace.getConfiguration("godboltLite", document.uri).get<boolean>("codeLens.enabled", true);
}

function configurationChangeAffectsAssembly(event: vscode.ConfigurationChangeEvent): boolean {
  return [
    "godboltLite.compilerPath",
    "godboltLite.compilerArgs",
    "godboltLite.extraCompilerArgs",
    "godboltLite.useCompileCommands",
    "godboltLite.compileCommandsPath",
    "godboltLite.inferHeaderCompileCommand",
    "godboltLite.useCompileFlags",
    "godboltLite.compileFlagsPath",
    "godboltLite.includeWorkspaceFolder",
    "godboltLite.showDiagnostics",
    "godboltLite.filters.trimMetadataDirectives",
    "godboltLite.filters.trimComments",
    "godboltLite.filters.trimBlankLines",
    "godboltLite.timeoutMs",
    "godboltLite.maxOutputBytes"
  ].some((section) => event.affectsConfiguration(section));
}

function hasAssemblyDocument(document: vscode.TextDocument): boolean {
  return assemblyUrisBySource.has(document.uri.toString());
}

function assemblyUriFor(document: vscode.TextDocument): vscode.Uri {
  const sourceUri = document.uri.toString();
  const existing = assemblyUrisBySource.get(sourceUri);
  if (existing) return existing;
  const safeName = `${path.basename(document.fileName).replace(/[^\w.-]/gu, "_")}.s`;
  const uri = vscode.Uri.from({
    scheme: assemblyScheme,
    path: `/${safeName}`,
    query: sourceUri
  });
  assemblyUrisBySource.set(sourceUri, uri);
  return uri;
}

async function sourceDocumentForActiveEditor(): Promise<vscode.TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (!active) return undefined;
  if (isSupportedDocument(active)) return active;
  if (active.uri.scheme !== assemblyScheme || !active.uri.query) return undefined;
  const sourceUri = vscode.Uri.parse(active.uri.query);
  const document = await vscode.workspace.openTextDocument(sourceUri);
  return isSupportedDocument(document) ? document : undefined;
}

async function sourceDocumentForCommandTarget(target?: unknown): Promise<vscode.TextDocument | undefined> {
  const targetUri = commandTargetUri(target);
  if (!targetUri) return sourceDocumentForActiveEditor();
  const sourceUri = targetUri.scheme === assemblyScheme && targetUri.query ? vscode.Uri.parse(targetUri.query) : targetUri;
  const document = await vscode.workspace.openTextDocument(sourceUri);
  return isSupportedDocument(document) ? document : undefined;
}

async function assemblyDocumentForCommandTarget(target?: unknown): Promise<vscode.TextDocument | undefined> {
  const targetUri = commandTargetUri(target);
  if (targetUri?.scheme === assemblyScheme) {
    return vscode.workspace.openTextDocument(targetUri);
  }
  const active = vscode.window.activeTextEditor?.document;
  return active?.uri.scheme === assemblyScheme ? active : undefined;
}

async function promptForAssemblySaveUri(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
  return vscode.window.showSaveDialog({
    defaultUri: defaultAssemblySaveUri(document),
    filters: {
      Assembly: ["s", "asm"],
      "All Files": ["*"]
    },
    saveLabel: "Save Assembly"
  });
}

function defaultAssemblySaveUri(document: vscode.TextDocument): vscode.Uri {
  const sourceUri = document.uri.query ? vscode.Uri.parse(document.uri.query) : undefined;
  if (sourceUri?.scheme === "file") {
    const sourceName = path.basename(sourceUri.fsPath, path.extname(sourceUri.fsPath));
    return vscode.Uri.file(path.join(path.dirname(sourceUri.fsPath), `${sourceName || "assembly"}.s`));
  }
  if (sourceUri?.path) {
    const sourceName = path.posix.basename(sourceUri.path, path.posix.extname(sourceUri.path));
    const directory = path.posix.dirname(sourceUri.path);
    const savePath = directory === "/" ? `/${sourceName || "assembly"}.s` : `${directory}/${sourceName || "assembly"}.s`;
    return sourceUri.with({ path: savePath, query: "", fragment: "" });
  }
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (workspaceUri) return vscode.Uri.joinPath(workspaceUri, "assembly.s");
  return vscode.Uri.file(path.resolve("assembly.s"));
}

async function promptForAssemblyFilters(current: Record<AssemblyFilterId, boolean>): Promise<Set<AssemblyFilterId> | undefined> {
  const picks = assemblyFilterOptions.map((option) => ({
    label: option.label,
    description: option.description,
    picked: current[option.id],
    option
  }));
  const selected = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    placeHolder: "Select filters to apply to Godbolt Lite assembly output"
  });
  return selected ? new Set(selected.map((item) => item.option.id)) : undefined;
}

async function promptForCompilerUri(resource?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const currentPath = vscode.workspace.getConfiguration("godboltLite", resource).get<string>("compilerPath", "").trim();
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: currentPath && path.isAbsolute(currentPath) ? vscode.Uri.file(currentPath) : undefined,
    openLabel: "Use Compiler",
    title: "Select C/C++ Compiler"
  });
  return selected?.[0];
}

function filterSelectionFromCommandArg(value: unknown): Set<AssemblyFilterId> | undefined {
  if (!Array.isArray(value)) return undefined;
  const selected = new Set<AssemblyFilterId>();
  for (const item of value) {
    if (isAssemblyFilterId(item)) selected.add(item);
  }
  return selected;
}

function isAssemblyFilterId(value: unknown): value is AssemblyFilterId {
  return typeof value === "string" && assemblyFilterOptions.some((option) => option.id === value);
}

function configurationTargetForSetting(
  section: vscode.WorkspaceConfiguration,
  setting: string
): vscode.ConfigurationTarget {
  const inspected = section.inspect(setting);
  if (inspected?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

function commandTargetUri(target: unknown): vscode.Uri | undefined {
  if (target instanceof vscode.Uri) return target;
  if (!target || typeof target !== "object") return undefined;
  const resourceUri = (target as { readonly resourceUri?: unknown }).resourceUri;
  return resourceUri instanceof vscode.Uri ? resourceUri : undefined;
}

function sourceUriForCommandResource(uri: vscode.Uri | undefined): vscode.Uri | undefined {
  return uri?.scheme === assemblyScheme && uri.query ? vscode.Uri.parse(uri.query) : uri;
}

function removeAssemblyUri(uri: vscode.Uri): void {
  for (const [sourceUri, assemblyUri] of assemblyUrisBySource.entries()) {
    if (assemblyUri.toString() === uri.toString()) {
      assemblyUrisBySource.delete(sourceUri);
      sourceCodeLensProvider?.refresh();
      compileGenerationsBySource.delete(sourceUri);
      const pending = pendingCompilesBySource.get(sourceUri);
      if (pending) clearTimeout(pending);
      pendingCompilesBySource.delete(sourceUri);
      cancelRunningCompile(sourceUri);
      clearDiagnosticsForSource(sourceUri);
      return;
    }
  }
}

function recompileAffectedAssemblyDocuments(event: vscode.ConfigurationChangeEvent): void {
  for (const sourceKey of assemblyUrisBySource.keys()) {
    const sourceUri = vscode.Uri.parse(sourceKey);
    if (!event.affectsConfiguration("godboltLite", sourceUri)) continue;
    recompileAssemblySource(sourceUri);
  }
}

function recompileOpenAssemblyDocuments(): void {
  for (const sourceKey of assemblyUrisBySource.keys()) {
    recompileAssemblySource(vscode.Uri.parse(sourceKey));
  }
}

function recompileAssemblySource(sourceUri: vscode.Uri): void {
  void vscode.workspace.openTextDocument(sourceUri).then(
    (document) => {
      if (isSupportedDocument(document) && hasAssemblyDocument(document)) scheduleCompile(document, 0);
    },
    () => undefined
  );
}

function cancelRunningCompile(sourceUri: string): void {
  const running = runningCompilesBySource.get(sourceUri);
  if (!running) return;
  running.stop();
  runningCompilesBySource.delete(sourceUri);
}

function getConfig(resource?: vscode.Uri) {
  const section = vscode.workspace.getConfiguration("godboltLite", resource);
  const compilerArgs = section.get<string[]>("compilerArgs", []);
  if (!Array.isArray(compilerArgs) || compilerArgs.some((arg) => typeof arg !== "string")) {
    throw new Error("godboltLite.compilerArgs must be an array of strings.");
  }
  const extraCompilerArgs = section.get<string[]>("extraCompilerArgs", []);
  if (!Array.isArray(extraCompilerArgs) || extraCompilerArgs.some((arg) => typeof arg !== "string")) {
    throw new Error("godboltLite.extraCompilerArgs must be an array of strings.");
  }
  return {
    compilerPath: section.get<string>("compilerPath", "").trim(),
    compilerArgs,
    extraCompilerArgs,
    useCompileCommands: section.get<boolean>("useCompileCommands", true),
    compileCommandsPath: section.get<string>("compileCommandsPath", "").trim(),
    inferHeaderCompileCommand: section.get<boolean>("inferHeaderCompileCommand", true),
    useCompileFlags: section.get<boolean>("useCompileFlags", true),
    compileFlagsPath: section.get<string>("compileFlagsPath", "").trim(),
    includeWorkspaceFolder: section.get<boolean>("includeWorkspaceFolder", true),
    autoCompile: section.get<boolean>("autoCompile", true),
    debounceMs: clampNumber(section.get<number>("debounceMs", 500), 100, 5000),
    timeoutMs: clampNumber(section.get<number>("timeoutMs", 10000), 1000, 60000),
    maxOutputBytes: clampNumber(section.get<number>("maxOutputBytes", 1048576), 65536, 8388608),
    showDiagnostics: section.get<boolean>("showDiagnostics", true),
    assemblyFilters: {
      trimMetadataDirectives: section.get<boolean>("filters.trimMetadataDirectives", true),
      trimComments: section.get<boolean>("filters.trimComments", false),
      trimBlankLines: section.get<boolean>("filters.trimBlankLines", true)
    }
  };
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "c" || document.languageId === "cpp";
}

function defaultCompilerFor(document: vscode.TextDocument): string {
  return document.languageId === "cpp" ? "clang++" : "clang";
}

function compilerLanguage(document: vscode.TextDocument): string {
  return document.languageId === "cpp" ? "c++" : "c";
}

function extensionForDocument(document: vscode.TextDocument): string {
  return document.languageId === "cpp" ? ".cpp" : ".c";
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function setStatus(text: string): void {
  statusBar.text = text;
  statusBar.show();
}

function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

function quoteArg(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/"/gu, "\\\"")}"`;
}
