import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  chooseInferredCompileCommandPath,
  parseCompilationCommand,
  parseCompileFlagsText,
  sanitizeCompileCommandArgs
} = require("../out/compileCommands.js");

test("parseCompileFlagsText reads one argument per line", () => {
  assert.deepEqual(
    parseCompileFlagsText(`
# comment
-I
include
-DNAME=value with spaces

-std=c++20
`),
    ["-I", "include", "-DNAME=value with spaces", "-std=c++20"]
  );
});

test("parseCompilationCommand handles quoted arguments", () => {
  assert.deepEqual(
    parseCompilationCommand('clang++ -I "vendor include" -DNAME="hello world" -c "src/main.cpp"'),
    ["clang++", "-I", "vendor include", "-DNAME=hello world", "-c", "src/main.cpp"]
  );
});

test("parseCompilationCommand preserves Windows paths in quoted command strings", () => {
  assert.deepEqual(
    parseCompilationCommand(String.raw`"C:\Program Files\LLVM\bin\clang.exe" -I "C:\project\include dir" -c "C:\project\src\main.c"`),
    [
      String.raw`C:\Program Files\LLVM\bin\clang.exe`,
      "-I",
      String.raw`C:\project\include dir`,
      "-c",
      String.raw`C:\project\src\main.c`
    ]
  );
});

test("parseCompilationCommand handles escaped spaces outside quotes", () => {
  assert.deepEqual(
    parseCompilationCommand(String.raw`clang -I vendor\ include -DNAME=hello\ world -c src/main.c`),
    ["clang", "-I", "vendor include", "-DNAME=hello world", "-c", "src/main.c"]
  );
});

test("sanitizeCompileCommandArgs keeps project flags and removes output/source args", () => {
  const directory = path.resolve("fixture/project");
  const source = path.join(directory, "src", "main.cpp");
  assert.deepEqual(
    sanitizeCompileCommandArgs(
      [
        "clang++",
        "-I",
        "include",
        "-DNAME=1",
        "-std=c++20",
        "-MD",
        "-MF",
        "main.d",
        "-c",
        "src/main.cpp",
        "-o",
        "main.o"
      ],
      source,
      directory
    ),
    ["-I", "include", "-DNAME=1", "-std=c++20"]
  );
});

test("sanitizeCompileCommandArgs removes attached output arguments", () => {
  const directory = path.resolve("fixture/project");
  const source = path.join(directory, "main.c");
  assert.deepEqual(
    sanitizeCompileCommandArgs(
      ["clang", "--target=x86_64-pc-linux-gnu", "-omain.o", "-MFmain.d", "--output=ignored.o", "main.c"],
      source,
      directory
    ),
    ["--target=x86_64-pc-linux-gnu"]
  );
});

test("sanitizeCompileCommandArgs removes argument separator before appending assembly flags", () => {
  const directory = path.resolve("fixture/project");
  const source = path.join(directory, "main.c");
  assert.deepEqual(
    sanitizeCompileCommandArgs(["clang", "-DVALUE=1", "--", "main.c"], source, directory),
    ["-DVALUE=1"]
  );
});

test("chooseInferredCompileCommandPath prefers same-stem C++ source for hpp", () => {
  const root = path.resolve("fixture/project");
  assert.equal(
    chooseInferredCompileCommandPath(
      path.join(root, "include", "widget.hpp"),
      [
        path.join(root, "src", "main.c"),
        path.join(root, "src", "widget.cpp"),
        path.join(root, "src", "other.cpp")
      ]
    ),
    path.join(root, "src", "widget.cpp")
  );
});

test("chooseInferredCompileCommandPath prefers nearby source for generic h", () => {
  const root = path.resolve("fixture/project");
  assert.equal(
    chooseInferredCompileCommandPath(
      path.join(root, "lib", "detail", "config.h"),
      [
        path.join(root, "app", "main.cpp"),
        path.join(root, "lib", "detail", "worker.c")
      ]
    ),
    path.join(root, "lib", "detail", "worker.c")
  );
});
