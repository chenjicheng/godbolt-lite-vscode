# Godbolt Lite

Godbolt Lite is a local Compiler Explorer-style VS Code extension for C and C++.

It does not upload source code. It invokes a compiler in the VS Code workspace extension host with argv arguments and shows the generated assembly as a native read-only VS Code document beside the editor.

## Features

- Open assembly for the active C/C++ file with `Godbolt Lite: Open Assembly`.
- Use the Godbolt Lite Getting Started walkthrough to configure the extension inside VS Code.
- Pick a compiler executable with `Godbolt Lite: Select Compiler...` from the Command Palette, source editor context menu, or Explorer context menu.
- Use the `Open Assembly` CodeLens shown at the top of C/C++ files; it switches to `Refresh Assembly` once an assembly view exists.
- Open assembly from the VS Code Explorer context menu for C/C++ files and reveal the source beside it.
- Show output in a normal VS Code editor tab using a virtual `godbolt-lite:` document.
- Recompile with `Godbolt Lite: Compile Active File`.
- Refresh assembly or jump back to the source directly from the assembly editor title.
- Copy the current assembly document from the assembly editor title or context menu.
- Copy the compiler command used for the current assembly document.
- Save the current assembly document as a `.s` or `.asm` file.
- Configure assembly filters from the assembly document context menu.
- Follow links from the assembly header to the source file, `compile_commands.json`, or `compile_flags.txt`.
- Open the Godbolt Lite output log for compiler invocations and stderr details.
- Auto-compile on edit/save while an assembly document exists for that source file.
- Publish compiler errors, warnings, and notes to the VS Code Problems panel.
- Compile dirty editors by writing their current text to a temporary file.
- Reuse matching `compile_commands.json` entries when available.
- Infer a compile command for headers from nearby source files when build systems omit header entries.
- Reuse `compile_flags.txt` for simple projects when no compilation database entry is available.
- Recompile open assembly views when `compile_commands.json` or `compile_flags.txt` changes, including explicitly configured paths outside the workspace.
- Pass compiler arguments as a JSON array, not shell text.
- Enforce compiler timeout and output size limits.
- Cancel an older compile for the same source file when a newer one starts.
- Filter noisy assembly metadata directives by default while keeping labels and compiler comments.

## Requirements

Install a local C/C++ compiler and make it available on `PATH`.

By default:

- C files use `clang`.
- C++ files use `clang++`.

Run `Godbolt Lite: Select Compiler...` from the Command Palette or a source file context menu, or set `godboltLite.compilerPath`, if you want to use a specific executable.

On Windows, if `clang` is not on `PATH`, point the setting at an installed compiler:

```json
{
  "godboltLite.compilerPath": "C:\\Program Files\\LLVM\\bin\\clang.exe"
}
```

For Remote SSH, Dev Containers, and WSL, the compiler is resolved in the remote workspace extension host. This is intentional so the command sees the same filesystem as the source file.

## Compilation Database

Godbolt Lite looks for `compile_commands.json` by default. It checks parent folders of the source file and common `build/` subfolders, similar to C/C++ tooling conventions.

When a matching entry is found:

- `arguments` is preferred because the Clang JSON Compilation Database format defines it as ready-to-execute argv.
- `command` is used as a fallback with limited shell-style parsing.
- project flags such as `-I`, `-D`, `-std`, and target options are reused.
- output, dependency, compile-only, and original source-file arguments are replaced with `-S -o -` and the active editor content.
- `godboltLite.extraCompilerArgs` is appended after database flags.

Headers usually do not appear in `compile_commands.json`. When `godboltLite.inferHeaderCompileCommand` is enabled, Godbolt Lite uses a conservative clangd-style heuristic:

- exact header entries still win if present
- same basename source files are preferred
- `.hpp`/`.hh`/`.hxx` prefer C++ source files
- otherwise, nearby source files in the filesystem are preferred

This is a heuristic because different translation units can include the same header with different flags. If it picks the wrong context for a project, disable it and use `compile_flags.txt` or explicit settings.

When no matching entry is found, Godbolt Lite looks for `compile_flags.txt`. This follows the Clang tooling convention for simple projects:

- one argument per line
- paths are relative to the file containing `compile_flags.txt`
- the same flags apply to every source file

When neither `compile_commands.json` nor `compile_flags.txt` is found, Godbolt Lite falls back to `godboltLite.compilerArgs`.

## Settings

Settings are read for the active source file, so folder-level settings work in multi-root workspaces. `godboltLite.compilerPath` is machine-overridable because compiler install paths normally differ between local, remote, WSL, and container hosts. Project flags and filter options are resource-scoped and can live in user, workspace, or folder settings.

```json
{
  "godboltLite.compilerPath": "",
  "godboltLite.useCompileCommands": true,
  "godboltLite.compileCommandsPath": "",
  "godboltLite.inferHeaderCompileCommand": true,
  "godboltLite.useCompileFlags": true,
  "godboltLite.compileFlagsPath": "",
  "godboltLite.compilerArgs": [
    "-Og",
    "-g0",
    "-fno-asynchronous-unwind-tables",
    "-fno-stack-protector",
    "-fno-ident",
    "-fno-addrsig"
  ],
  "godboltLite.extraCompilerArgs": [],
  "godboltLite.includeWorkspaceFolder": true,
  "godboltLite.autoCompile": true,
  "godboltLite.codeLens.enabled": true,
  "godboltLite.showDiagnostics": true,
  "godboltLite.filters.trimMetadataDirectives": true,
  "godboltLite.filters.trimComments": false,
  "godboltLite.filters.trimBlankLines": true,
  "godboltLite.debounceMs": 500,
  "godboltLite.timeoutMs": 10000,
  "godboltLite.maxOutputBytes": 1048576
}
```

## Assembly Filters

Godbolt Lite applies conservative assembly filtering before writing the virtual assembly document:

- `godboltLite.filters.trimMetadataDirectives`: hides common metadata/debug directives such as `.file`, `.loc`, `.cfi_*`, `.debug_*`, and `.ident`.
- `godboltLite.filters.trimBlankLines`: collapses repeated blank lines.
- `godboltLite.filters.trimComments`: hides comments, disabled by default because compiler comments often explain generated code.

Use `Godbolt Lite: Configure Assembly Filters...` from an assembly document to update these settings without leaving the editor.

Labels are kept by default to avoid hiding branch targets.

## Development

```powershell
npm install
npm run compile
npm test
npm run test:integration:min
npm run test:vsix-install
npm run package
```

Open this folder in VS Code, press `F5`, then run `Godbolt Lite: Open Assembly` in the extension development host.

`npm test` runs both Node unit tests for parsing/filtering helpers and a VS Code Extension Host smoke test using `@vscode/test-electron`. The smoke test defaults to the stable VS Code test build. Use `npm run test:integration:min` to test the minimum supported VS Code version declared in `engines.vscode`, or pass `-- --version <version>` to `test:integration`. Use `npm run test:vsix-install` to package the extension, install the VSIX into an isolated VS Code profile, and run a smoke test from the installed extension directory.

## CI and Release

Pushes and pull requests to `main` run TypeScript compilation, Node unit tests, VS Code Extension Host smoke tests on both the minimum supported VS Code version and latest stable, VSIX packaging, and isolated packaged-VSIX runtime verification.

Pushing a `v*` tag runs the same unit and dual-version Extension Host test suite before packaging `godbolt-lite-${tag}.vsix` and publishing it to a GitHub Release.

## Scope

This repository has moved away from the standalone browser UI. The extension intentionally lets VS Code own file management, tabs, editing, source navigation, search, copy, and scrolling.
