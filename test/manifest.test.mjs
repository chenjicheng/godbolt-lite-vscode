import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const manifest = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));

test("user-facing commands are grouped and scoped in the Command Palette", () => {
  const commands = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
  assert.deepEqual(
    [...commands.keys()].sort(),
    [
      "godboltLite.compile",
      "godboltLite.configureAssemblyFilters",
      "godboltLite.copyAssembly",
      "godboltLite.copyCompilerCommand",
      "godboltLite.openAssembly",
      "godboltLite.openSource",
      "godboltLite.refreshAssembly",
      "godboltLite.saveAssembly",
      "godboltLite.showOutput"
    ]
  );

  for (const command of commands.values()) {
    assert.equal(command.category, "Godbolt Lite");
    assert.match(command.icon, /^\$\([^)]+\)$/u);
    assert.ok(!command.title.startsWith("Godbolt Lite:"), "category should provide the command palette prefix");
  }

  const commandPalette = manifest.contributes.menus.commandPalette ?? [];
  const commandPaletteByCommand = new Map(commandPalette.map((item) => [item.command, item.when]));
  assert.equal(commandPaletteByCommand.get("godboltLite.openAssembly"), "editorLangId == c || editorLangId == cpp");
  assert.equal(commandPaletteByCommand.get("godboltLite.compile"), "editorLangId == c || editorLangId == cpp");
  assert.equal(commandPaletteByCommand.get("godboltLite.refreshAssembly"), "resourceScheme == 'godbolt-lite'");
  assert.equal(commandPaletteByCommand.get("godboltLite.openSource"), "resourceScheme == 'godbolt-lite'");
  assert.equal(commandPaletteByCommand.get("godboltLite.copyAssembly"), "resourceScheme == 'godbolt-lite'");
  assert.equal(commandPaletteByCommand.get("godboltLite.copyCompilerCommand"), "resourceScheme == 'godbolt-lite'");
  assert.equal(commandPaletteByCommand.get("godboltLite.saveAssembly"), "resourceScheme == 'godbolt-lite'");
  assert.equal(commandPaletteByCommand.get("godboltLite.configureAssemblyFilters"), "resourceScheme == 'godbolt-lite'");
  assert.ok(commandPalette.some((item) => item.command === "godboltLite.showOutput" && !("when" in item)));

  assert.deepEqual(manifest.contributes.menus["editor/title"], [
    {
      command: "godboltLite.openAssembly",
      group: "navigation",
      when: "resourceLangId == c || resourceLangId == cpp"
    },
    {
      command: "godboltLite.refreshAssembly",
      group: "navigation@1",
      when: "resourceScheme == 'godbolt-lite'"
    },
    {
      command: "godboltLite.openSource",
      group: "navigation@2",
      when: "resourceScheme == 'godbolt-lite'"
    },
    {
      command: "godboltLite.copyAssembly",
      group: "navigation@3",
      when: "resourceScheme == 'godbolt-lite'"
    }
  ]);

  assert.deepEqual(manifest.contributes.menus["editor/context"], [
    {
      command: "godboltLite.openAssembly",
      group: "navigation",
      when: "resourceLangId == c || resourceLangId == cpp"
    },
    {
      command: "godboltLite.refreshAssembly",
      group: "navigation@1",
      when: "resourceScheme == 'godbolt-lite'"
    },
    {
      command: "godboltLite.openSource",
      group: "navigation@2",
      when: "resourceScheme == 'godbolt-lite'"
    },
    {
      command: "godboltLite.copyAssembly",
      group: "navigation@3",
      when: "resourceScheme == 'godbolt-lite'"
    },
    {
      command: "godboltLite.copyCompilerCommand",
      group: "navigation@4",
      when: "resourceScheme == 'godbolt-lite'"
    },
    {
      command: "godboltLite.saveAssembly",
      group: "navigation@5",
      when: "resourceScheme == 'godbolt-lite'"
    },
    {
      command: "godboltLite.configureAssemblyFilters",
      group: "navigation@6",
      when: "resourceScheme == 'godbolt-lite'"
    }
  ]);

  assert.deepEqual(manifest.contributes.menus["explorer/context"], [
    {
      command: "godboltLite.openAssembly",
      group: "navigation",
      when: "resourceLangId == c || resourceLangId == cpp"
    }
  ]);
});

test("activation events avoid startup on passive C/C++ file open", () => {
  assert.deepEqual(
    manifest.activationEvents,
    [
      "onCommand:godboltLite.openAssembly",
      "onCommand:godboltLite.compile",
      "onCommand:godboltLite.refreshAssembly",
      "onCommand:godboltLite.openSource",
      "onCommand:godboltLite.copyAssembly",
      "onCommand:godboltLite.copyCompilerCommand",
      "onCommand:godboltLite.showOutput",
      "onCommand:godboltLite.saveAssembly",
      "onCommand:godboltLite.configureAssemblyFilters"
    ]
  );
});

test("configuration scopes support per-resource projects and machine-local compiler paths", () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties["godboltLite.compilerPath"].scope, "machine-overridable");

  for (const [name, property] of Object.entries(properties)) {
    assert.ok(property.scope, `${name} must declare an explicit configuration scope`);
    if (name !== "godboltLite.compilerPath") {
      assert.equal(property.scope, "resource", `${name} should support file, folder, and workspace settings`);
    }
  }
});
