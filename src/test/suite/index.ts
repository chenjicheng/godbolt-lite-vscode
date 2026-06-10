import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const assemblyScheme = "godbolt-lite";

export async function run(): Promise<void> {
  await configureFakeCompiler();
  await showsOutputLog();
  await openingAssemblyDoesNotAutoCompileTwice();
  await providesSourceCodeLens();
  await opensAssemblyWithConfiguredCompiler();
  await opensSourceFromAssemblyDocument();
  await refreshesAssemblyDocument();
  await copiesAssemblyDocument();
  await copiesCompilerCommandFromAssemblyDocument();
  await savesAssemblyDocument();
  await providesAssemblyDocumentLinks();
  await providesQuickFixForGodboltDiagnostics();
  await configuresAssemblyFilters();
  await opensAssemblyForCommandUriInsteadOfActiveEditor();
  await opensAssemblyForCommandResourceUriObject();
  await keepsSharedHeaderDiagnosticsFromOtherSources();
  await reportsCompilerTimeout();
  await recompilesOpenAssemblyDocumentsAfterConfigChange();
  await usesCompilationDatabaseForHeaderInference();
  await usesCompileFlagsFallback();
  await recompilesOpenAssemblyDocumentsAfterCompileFlagsChange();
  await recompilesOpenAssemblyDocumentsAfterExternalCompileFlagsChange();
  await selectsCompilerPath();
  await reportsCompilerStartFailure();
}

function fixturePath(name: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Expected the fixture workspace to be open.");
  return path.join(workspaceFolder.uri.fsPath, name);
}

async function configureFakeCompiler(): Promise<void> {
  await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
  await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs")]);
  await updateConfig("useCompileCommands", false);
  await updateConfig("useCompileFlags", false);
  await updateConfig("autoCompile", false);
  await updateConfig("timeoutMs", 5000);
}

async function showsOutputLog(): Promise<void> {
  await vscode.commands.executeCommand("godboltLite.showOutput");
}

async function selectsCompilerPath(): Promise<void> {
  const sourceUri = vscode.Uri.file(fixturePath("main.c"));
  const nodePath = process.env.npm_node_execpath;
  assert.ok(nodePath, "Expected npm_node_execpath to point to the test Node.js executable.");
  const selectedCompiler = vscode.Uri.file(nodePath);
  try {
    await updateConfig("compilerPath", "node");
    await vscode.commands.executeCommand("godboltLite.selectCompiler", sourceUri, selectedCompiler);
    assert.equal(
      vscode.workspace.getConfiguration("godboltLite", sourceUri).get("compilerPath"),
      selectedCompiler.fsPath
    );

    await updateConfig("compilerPath", "node");
    await vscode.commands.executeCommand("godboltLite.selectCompiler", { resourceUri: sourceUri }, selectedCompiler);
    assert.equal(
      vscode.workspace.getConfiguration("godboltLite", sourceUri).get("compilerPath"),
      selectedCompiler.fsPath
    );

    await updateConfig("compilerPath", "node");
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");
    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
    await vscode.window.showTextDocument(assemblyDocument);
    await vscode.commands.executeCommand("godboltLite.selectCompiler", undefined, selectedCompiler);
    assert.equal(
      vscode.workspace.getConfiguration("godboltLite", sourceUri).get("compilerPath"),
      selectedCompiler.fsPath
    );
  } finally {
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
  }
}

async function reportsCompilerStartFailure(): Promise<void> {
  const missingCompiler = path.join(os.tmpdir(), `godbolt-lite-missing-compiler-${Date.now()}`);
  const sourceUri = vscode.Uri.file(fixturePath("main.c"));
  try {
    await updateConfig("compilerPath", missingCompiler);
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");
    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /Could not start compiler/u);
    assert.match(assemblyDocument.getText(), new RegExp(escapeRegExp(missingCompiler), "u"));
  } finally {
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function providesSourceCodeLens(): Promise<void> {
  const sourceUri = vscode.Uri.file(fixturePath("main.c"));
  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(sourceDocument);
  let assemblyDocument: vscode.TextDocument | undefined;

  try {
    await updateConfig("codeLens.enabled", true);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      sourceUri,
      10
    );
    const openAssemblyLens = lenses.find((lens) => lens.command?.command === "godboltLite.openAssembly");
    assert.ok(openAssemblyLens, "Expected Godbolt Lite CodeLens on C source files.");
    assert.equal(openAssemblyLens.range.start.line, 0);
    assert.equal(openAssemblyLens.command?.title, "Open Assembly");
    assert.equal(openAssemblyLens.command?.arguments?.[0]?.toString(), sourceUri.toString());

    await vscode.commands.executeCommand("godboltLite.openAssembly", sourceUri);
    assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
    const refreshedLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      sourceUri,
      10
    );
    const refreshAssemblyLens = refreshedLenses.find((lens) => lens.command?.command === "godboltLite.refreshAssembly");
    assert.ok(refreshAssemblyLens, "Expected Godbolt Lite CodeLens to switch to refresh after opening assembly.");
    assert.equal(refreshAssemblyLens.command?.title, "Refresh Assembly");
    assert.equal(refreshAssemblyLens.command?.arguments?.[0]?.toString(), sourceUri.toString());

    await updateConfig("codeLens.enabled", false);
    const disabledLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      sourceUri,
      10
    );
    assert.ok(!disabledLenses.some((lens) => lens.command?.command.startsWith("godboltLite.")));
  } finally {
    if (assemblyDocument) {
      await vscode.window.showTextDocument(assemblyDocument);
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
    await updateConfig("codeLens.enabled", true);
  }
}

async function opensAssemblyWithConfiguredCompiler(): Promise<void> {
  const sourceUri = vscode.Uri.file(fixturePath("main.c"));

  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(sourceDocument);
  await vscode.commands.executeCommand("godboltLite.openAssembly");

  const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
  const assembly = assemblyDocument.getText();
  assert.match(assembly, /# Godbolt Lite: compiled in \d+ ms/u);
  assert.match(assembly, /# Command: /u);
  assert.match(assembly, /\.globl square/u);
  assert.match(assembly, /movl\s+\$4,\s*%eax/u);
}

async function opensSourceFromAssemblyDocument(): Promise<void> {
  const sourceUri = vscode.Uri.file(fixturePath("target_success.c"));

  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(sourceDocument);
  await vscode.commands.executeCommand("godboltLite.openAssembly");

  const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
  await vscode.window.showTextDocument(assemblyDocument);
  await vscode.commands.executeCommand("godboltLite.openSource");

  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), sourceUri.toString());

  await vscode.window.showTextDocument(assemblyDocument);
  await vscode.commands.executeCommand("godboltLite.openSource", assemblyDocument.uri);

  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), sourceUri.toString());
}

async function refreshesAssemblyDocument(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-refresh-"));
  const countFile = path.join(tempDir, "count.txt");
  try {
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs"), "--count-file", countFile]);
    await updateConfig("useCompileCommands", false);
    await updateConfig("useCompileFlags", false);
    await updateConfig("autoCompile", false);

    const sourceUri = vscode.Uri.file(fixturePath("external_flags.c"));
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");

    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
    await waitForSourceCompileCount(countFile, "external_flags.c", 1);

    await vscode.commands.executeCommand("godboltLite.refreshAssembly", assemblyDocument.uri);

    await waitForSourceCompileCount(countFile, "external_flags.c", 2);

    await vscode.window.showTextDocument(assemblyDocument);
    await vscode.commands.executeCommand("godboltLite.compile");
    await waitForSourceCompileCount(countFile, "external_flags.c", 3);
  } finally {
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs")]);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function copiesAssemblyDocument(): Promise<void> {
  const originalClipboard = await vscode.env.clipboard.readText();
  try {
    const sourceUri = vscode.Uri.file(fixturePath("resource_object.c"));
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");

    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
    await vscode.commands.executeCommand("godboltLite.copyAssembly", assemblyDocument.uri);

    const copied = await vscode.env.clipboard.readText();
    assert.match(copied, /# Source: .*resource_object\.c/u);
    assert.match(copied, /fake compiler marker/u);

    await vscode.env.clipboard.writeText("");
    await vscode.window.showTextDocument(assemblyDocument);
    await vscode.commands.executeCommand("godboltLite.copyAssembly");

    const copiedFromActiveEditor = await vscode.env.clipboard.readText();
    assert.match(copiedFromActiveEditor, /# Source: .*resource_object\.c/u);
    assert.match(copiedFromActiveEditor, /fake compiler marker/u);
  } finally {
    await vscode.env.clipboard.writeText(originalClipboard);
  }
}

async function copiesCompilerCommandFromAssemblyDocument(): Promise<void> {
  const originalClipboard = await vscode.env.clipboard.readText();
  try {
    const sourceUri = vscode.Uri.file(fixturePath("resource_object.c"));
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");

    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /# Command: .*fake-compiler\.cjs/u);
    await vscode.commands.executeCommand("godboltLite.copyCompilerCommand", assemblyDocument.uri);

    const copied = await vscode.env.clipboard.readText();
    assert.match(copied, /fake-compiler\.cjs/u);
    assert.match(copied, /(?:^|\s)-S\s+-o\s+-/u);
    assert.doesNotMatch(copied, /^# Command:/u);

    await vscode.env.clipboard.writeText("unchanged clipboard");
    const emptyAssemblyUri = vscode.Uri.from({
      scheme: assemblyScheme,
      path: "/no-command.s",
      query: sourceUri.toString()
    });
    await vscode.workspace.openTextDocument(emptyAssemblyUri);
    await vscode.commands.executeCommand("godboltLite.copyCompilerCommand", emptyAssemblyUri);
    assert.equal(await vscode.env.clipboard.readText(), "unchanged clipboard");
  } finally {
    await vscode.env.clipboard.writeText(originalClipboard);
  }
}

async function savesAssemblyDocument(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-save-"));
  const saveUri = vscode.Uri.file(path.join(tempDir, "saved.s"));
  try {
    const sourceUri = vscode.Uri.file(fixturePath("resource_object.c"));
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");

    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
    await vscode.commands.executeCommand("godboltLite.saveAssembly", assemblyDocument.uri, saveUri);

    const saved = await fs.readFile(saveUri.fsPath, "utf8");
    assert.match(saved, /# Source: .*resource_object\.c/u);
    assert.match(saved, /fake compiler marker/u);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function providesAssemblyDocumentLinks(): Promise<void> {
  try {
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
    await updateConfig("useCompileCommands", false);
    await updateConfig("useCompileFlags", true);
    await updateConfig("compileFlagsPath", "");

    const sourceUri = vscode.Uri.file(fixturePath(path.join("metadata", "flags_source.c")));
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");

    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /# Compile flags: /u);
    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
      "vscode.executeLinkProvider",
      assemblyDocument.uri
    );

    const sourceLink = links.find((link) => link.target?.toString() === sourceUri.toString());
    assert.ok(sourceLink, "Expected assembly source header to link to the source file.");
    assert.match(assemblyDocument.getText(sourceLink.range), /flags_source\.c$/u);

    const flagsPath = fixturePath("compile_flags.txt");
    const flagsLink = links.find((link) => link.target?.fsPath === flagsPath);
    assert.ok(flagsLink, "Expected assembly compile flags header to link to compile_flags.txt.");
    assert.equal(assemblyDocument.getText(flagsLink.range), flagsPath);
  } finally {
    await updateConfig("useCompileFlags", false);
    await updateConfig("compileFlagsPath", "");
  }
}

async function providesQuickFixForGodboltDiagnostics(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-code-action-"));
  const countFile = path.join(tempDir, "count.txt");
  try {
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs"), "--count-file", countFile]);
    await updateConfig("useCompileCommands", false);
    await updateConfig("useCompileFlags", false);
    await updateConfig("autoCompile", false);

    const sourceUri = vscode.Uri.file(fixturePath("refresh.c"));
    await openAssemblyFor(sourceUri);
    const [diagnostic] = await waitForDiagnostics(sourceUri, 1);
    assert.equal(diagnostic.source, "Godbolt Lite");

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      sourceUri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value
    );
    const refreshAction = actions.find((action) => action.command?.command === "godboltLite.refreshAssembly");
    assert.ok(refreshAction, "Expected a Godbolt Lite refresh quick fix for compiler diagnostics.");
    assert.equal(refreshAction.title, "Refresh Godbolt Lite Assembly for This File");
    assert.deepEqual(refreshAction.command?.arguments?.map((arg) => arg?.toString()), [sourceUri.toString()]);

    const otherDiagnostics = vscode.languages.createDiagnosticCollection("other-diagnostics");
    try {
      const otherUri = vscode.Uri.file(fixturePath("target_success.c"));
      const otherDocument = await vscode.workspace.openTextDocument(otherUri);
      const otherRange = new vscode.Range(0, 0, 0, 1);
      const otherDiagnostic = new vscode.Diagnostic(otherRange, "other diagnostic", vscode.DiagnosticSeverity.Error);
      otherDiagnostic.source = "Other";
      otherDiagnostics.set(otherUri, [otherDiagnostic]);

      const nonGodboltActions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        otherUri,
        otherDocument.validateRange(otherRange),
        vscode.CodeActionKind.QuickFix.value
      );
      assert.ok(
        !nonGodboltActions.some((action) => action.command?.command === "godboltLite.refreshAssembly"),
        "Expected Godbolt Lite quick fixes to ignore diagnostics from other sources."
      );
    } finally {
      otherDiagnostics.dispose();
    }

    await waitForSourceCompileCount(countFile, "refresh.c", 1);
    await vscode.commands.executeCommand(refreshAction.command.command, ...(refreshAction.command.arguments ?? []));
    await waitForSourceCompileCount(countFile, "refresh.c", 2);
  } finally {
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs")]);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function configuresAssemblyFilters(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-filter-"));
  const countFile = path.join(tempDir, "count.txt");
  try {
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs"), "--count-file", countFile]);
    await updateConfig("filters.trimComments", false);

    const sourceUri = vscode.Uri.file(fixturePath("main.c"));
    const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(sourceDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly");

    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /# fake compiler marker/u);
    await waitForSourceCompileCount(countFile, "main.c", 1);
    await vscode.commands.executeCommand(
      "godboltLite.configureAssemblyFilters",
      assemblyDocument.uri,
      ["trimMetadataDirectives", "trimComments", "trimBlankLines"]
    );

    await waitForSourceCompileCount(countFile, "main.c", 2);
    const refreshedAssembly = await waitForAssemblyDocumentText(
      sourceUri,
      (text) => /movl\s+\$4,\s*%eax/u.test(text) && !/# fake compiler marker/u.test(text)
    );
    assert.doesNotMatch(refreshedAssembly.getText(), /# fake compiler marker/u);
    assert.equal(vscode.workspace.getConfiguration("godboltLite", sourceUri).get("filters.trimComments"), true);
  } finally {
    await updateConfig("filters.trimComments", false);
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs")]);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function opensAssemblyForCommandUriInsteadOfActiveEditor(): Promise<void> {
  const activeUri = vscode.Uri.file(fixturePath("main.c"));
  const targetUri = vscode.Uri.file(fixturePath("target_success.c"));

  const activeDocument = await vscode.workspace.openTextDocument(activeUri);
  await vscode.window.showTextDocument(activeDocument);
  await vscode.commands.executeCommand("godboltLite.openAssembly", targetUri);

  const assemblyDocument = await waitForAssemblyDocument(targetUri, /fake compiler marker/u);
  assertVisibleEditor(targetUri);
  assert.match(assemblyDocument.getText(), /# Source: .*target_success\.c/u);
}

async function opensAssemblyForCommandResourceUriObject(): Promise<void> {
  const activeUri = vscode.Uri.file(fixturePath("main.c"));
  const targetUri = vscode.Uri.file(fixturePath("resource_object.c"));

  const activeDocument = await vscode.workspace.openTextDocument(activeUri);
  await vscode.window.showTextDocument(activeDocument);
  await vscode.commands.executeCommand("godboltLite.openAssembly", { resourceUri: targetUri });

  const assemblyDocument = await waitForAssemblyDocument(targetUri, /fake compiler marker/u);
  assertVisibleEditor(targetUri);
  assert.match(assemblyDocument.getText(), /# Source: .*resource_object\.c/u);
}

async function openingAssemblyDoesNotAutoCompileTwice(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-count-"));
  const countFile = path.join(tempDir, "count.txt");
  try {
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs"), "--count-file", countFile]);
    await updateConfig("useCompileCommands", false);
    await updateConfig("useCompileFlags", false);
    await updateConfig("autoCompile", true);
    await updateConfig("debounceMs", 100);

    const activeUri = vscode.Uri.file(fixturePath("main.c"));
    const targetUri = vscode.Uri.file(fixturePath("target_success.c"));
    const activeDocument = await vscode.workspace.openTextDocument(activeUri);
    await vscode.window.showTextDocument(activeDocument);
    await vscode.commands.executeCommand("godboltLite.openAssembly", targetUri);
    await waitForAssemblyDocument(targetUri, /fake compiler marker/u);
    await delay(400);

    assert.equal(await compileCount(countFile), 1);
  } finally {
    await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs")]);
    await updateConfig("autoCompile", false);
    await updateConfig("debounceMs", 500);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function keepsSharedHeaderDiagnosticsFromOtherSources(): Promise<void> {
  const sourceA = vscode.Uri.file(fixturePath("source_a.c"));
  const sourceB = vscode.Uri.file(fixturePath("source_b.c"));
  const header = vscode.Uri.file(fixturePath("common.h"));

  await openAssemblyFor(sourceA);
  await waitForDiagnostics(header, 1);

  await openAssemblyFor(sourceB);
  await waitForDiagnostics(header, 2);

  const sourceADocument = await vscode.workspace.openTextDocument(sourceA);
  const editor = await vscode.window.showTextDocument(sourceADocument);
  const fullRange = new vscode.Range(
    sourceADocument.positionAt(0),
    sourceADocument.positionAt(sourceADocument.getText().length)
  );
  await editor.edit((edit) => edit.replace(fullRange, "int source_a(void) { return 1; }\n"));
  await vscode.commands.executeCommand("godboltLite.compile");
  await waitForDiagnostics(header, 1);

  const remaining = vscode.languages.getDiagnostics(header);
  assert.equal(remaining[0]?.message, "shared header issue from source_b.c");
}

async function reportsCompilerTimeout(): Promise<void> {
  await updateConfig("timeoutMs", 1000);
  const sourceUri = vscode.Uri.file(fixturePath("timeout.c"));
  await openAssemblyFor(sourceUri);
  const assemblyDocument = await waitForAssemblyDocument(sourceUri, /stopped the compiler after 1000 ms/u);
  assert.match(assemblyDocument.getText(), /compiler exited with/u);
  await updateConfig("timeoutMs", 5000);
}

async function recompilesOpenAssemblyDocumentsAfterConfigChange(): Promise<void> {
  await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
  await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs")]);
  await updateConfig("useCompileCommands", false);
  await updateConfig("useCompileFlags", false);
  await updateConfig("autoCompile", false);

  const sourceUri = vscode.Uri.file(fixturePath("refresh.c"));
  await openAssemblyFor(sourceUri);
  await waitForAssemblyDocument(sourceUri, /missing expected arg -DREFRESHED/u);

  const inactiveDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(fixturePath("main.c")));
  await vscode.window.showTextDocument(inactiveDocument);
  await updateConfig("compilerArgs", [fixturePath("fake-compiler.cjs"), "-DREFRESHED"]);

  const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
  assert.doesNotMatch(assemblyDocument.getText(), /missing expected arg -DREFRESHED/u);
}

async function usesCompilationDatabaseForHeaderInference(): Promise<void> {
  await updateConfig("compilerPath", "");
  await updateConfig("useCompileCommands", true);
  await updateConfig("compileCommandsPath", "");
  await updateConfig("inferHeaderCompileCommand", true);
  await updateConfig("useCompileFlags", false);

  const sourceUri = vscode.Uri.file(fixturePath(path.join("metadata", "widget.hpp")));
  await openAssemblyFor(sourceUri);
  const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
  const assembly = assemblyDocument.getText();
  assert.match(assembly, /# Compilation database: /u);
  assert.match(assembly, /-DHEADER_CONTEXT=1/u);
}

async function usesCompileFlagsFallback(): Promise<void> {
  await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
  await updateConfig("useCompileCommands", false);
  await updateConfig("useCompileFlags", true);
  await updateConfig("compileFlagsPath", "");

  const sourceUri = vscode.Uri.file(fixturePath(path.join("metadata", "flags_source.c")));
  await openAssemblyFor(sourceUri);
  const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
  const assembly = assemblyDocument.getText();
  assert.match(assembly, /# Compile flags: /u);
  assert.match(assembly, /-DFLAGS_FILE=1/u);
}

async function recompilesOpenAssemblyDocumentsAfterCompileFlagsChange(): Promise<void> {
  const flagsPath = fixturePath("compile_flags.txt");
  const originalFlags = await fs.readFile(flagsPath, "utf8");
  try {
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
    await updateConfig("useCompileCommands", false);
    await updateConfig("useCompileFlags", true);
    await updateConfig("compileFlagsPath", "");
    await updateConfig("autoCompile", false);

    const sourceUri = vscode.Uri.file(fixturePath(path.join("metadata", "flags_source.c")));
    await openAssemblyFor(sourceUri);
    await waitForAssemblyDocument(sourceUri, /-DFLAGS_FILE=1/u);

    await fs.writeFile(flagsPath, `${originalFlags.trimEnd()}\n-DCHANGED_FLAGS=1\n`, "utf8");
    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /-DCHANGED_FLAGS=1/u);
    assert.match(assemblyDocument.getText(), /# Compile flags: /u);
  } finally {
    await fs.writeFile(flagsPath, originalFlags, "utf8").catch(() => undefined);
  }
}

async function recompilesOpenAssemblyDocumentsAfterExternalCompileFlagsChange(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-flags-"));
  const flagsPath = path.join(tempDir, "compile_flags.txt");
  try {
    await fs.writeFile(flagsPath, `${fixturePath("fake-compiler.cjs")}\n-DEXTERNAL_FLAGS=1\n`, "utf8");
    await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
    await updateConfig("useCompileCommands", false);
    await updateConfig("useCompileFlags", true);
    await updateConfig("compileFlagsPath", flagsPath);
    await updateConfig("autoCompile", false);

    const sourceUri = vscode.Uri.file(fixturePath("external_flags.c"));
    await openAssemblyFor(sourceUri);
    await waitForAssemblyDocument(sourceUri, /-DEXTERNAL_FLAGS=1/u);

    await fs.writeFile(flagsPath, `${fixturePath("fake-compiler.cjs")}\n-DEXTERNAL_FLAGS=2\n`, "utf8");
    const assemblyDocument = await waitForAssemblyDocument(sourceUri, /-DEXTERNAL_FLAGS=2/u);
    assert.match(assemblyDocument.getText(), /# Compile flags: /u);
  } finally {
    await updateConfig("compileFlagsPath", "");
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function openAssemblyFor(sourceUri: vscode.Uri): Promise<void> {
  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(sourceDocument);
  await vscode.commands.executeCommand("godboltLite.openAssembly");
}

async function updateConfig<T>(key: string, value: T): Promise<void> {
  await vscode.workspace
    .getConfiguration("godboltLite")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

async function waitForAssemblyDocument(sourceUri: vscode.Uri, pattern: RegExp): Promise<vscode.TextDocument> {
  return waitForAssemblyDocumentText(sourceUri, (text) => pattern.test(text));
}

async function waitForAssemblyDocumentText(
  sourceUri: vscode.Uri,
  matches: (text: string) => boolean
): Promise<vscode.TextDocument> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const document = vscode.workspace.textDocuments.find((candidate) => (
      candidate.uri.scheme === assemblyScheme &&
      queryMatchesSource(candidate.uri.query, sourceUri) &&
      matches(candidate.getText())
    ));
    if (document) return document;
    await delay(100);
  }
  throw new Error(`Timed out waiting for assembly document for ${sourceUri.toString()}`);
}

async function waitForDiagnostics(uri: vscode.Uri, count: number): Promise<vscode.Diagnostic[]> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.length === count) return diagnostics;
    await delay(100);
  }
  const actual = vscode.languages.getDiagnostics(uri);
  throw new Error(`Timed out waiting for ${count} diagnostics for ${uri.toString()}, got ${actual.length}`);
}

async function waitForSourceCompileCount(filePath: string, sourceName: string, count: number): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await compileCount(filePath, sourceName) >= count) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${count} compiler invocations for ${sourceName} in ${filePath}`);
}

function queryMatchesSource(query: string, sourceUri: vscode.Uri): boolean {
  if (query === sourceUri.toString()) return true;
  try {
    return decodeURIComponent(query) === sourceUri.toString();
  } catch {
    return false;
  }
}

function assertVisibleEditor(uri: vscode.Uri): void {
  assert.ok(
    vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === uri.toString()),
    `Expected ${uri.toString()} to be visible.`
  );
}

async function compileCount(filePath: string, sourceName?: string): Promise<number> {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/u).filter(Boolean);
  return sourceName ? lines.filter((line) => line === sourceName).length : lines.length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
