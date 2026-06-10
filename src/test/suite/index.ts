import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

const assemblyScheme = "godbolt-lite";

export async function run(): Promise<void> {
  await configureFakeCompiler();
  await opensAssemblyWithConfiguredCompiler();
  await keepsSharedHeaderDiagnosticsFromOtherSources();
  await reportsCompilerTimeout();
  await usesCompilationDatabaseForHeaderInference();
  await usesCompileFlagsFallback();
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
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const document = vscode.workspace.textDocuments.find((candidate) => (
      candidate.uri.scheme === assemblyScheme &&
      queryMatchesSource(candidate.uri.query, sourceUri) &&
      pattern.test(candidate.getText())
    ));
    if (document) return document;
    await delay(100);
  }
  throw new Error(`Timed out waiting for assembly document for ${sourceUri.toString()}`);
}

async function waitForDiagnostics(uri: vscode.Uri, count: number): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (vscode.languages.getDiagnostics(uri).length === count) return;
    await delay(100);
  }
  const actual = vscode.languages.getDiagnostics(uri);
  throw new Error(`Timed out waiting for ${count} diagnostics for ${uri.toString()}, got ${actual.length}`);
}

function queryMatchesSource(query: string, sourceUri: vscode.Uri): boolean {
  if (query === sourceUri.toString()) return true;
  try {
    return decodeURIComponent(query) === sourceUri.toString();
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
