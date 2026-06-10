import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

const assemblyScheme = "godbolt-lite";

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Expected the fixture workspace to be open.");

  const workspacePath = workspaceFolder.uri.fsPath;
  const compilerScriptPath = path.join(workspacePath, "fake-compiler.cjs");
  const sourceUri = vscode.Uri.file(path.join(workspacePath, "main.c"));

  await updateConfig("compilerPath", process.env.npm_node_execpath ?? "node");
  await updateConfig("compilerArgs", [compilerScriptPath]);
  await updateConfig("useCompileCommands", false);
  await updateConfig("useCompileFlags", false);
  await updateConfig("autoCompile", false);

  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(sourceDocument);
  await vscode.commands.executeCommand("godboltLite.openAssembly");

  const assemblyDocument = await waitForAssemblyDocument(sourceUri, /fake compiler marker/u);
  assert.match(assemblyDocument.getText(), /\.globl square/u);
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
  throw new Error(`Timed out waiting for installed extension assembly document for ${sourceUri.toString()}`);
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
