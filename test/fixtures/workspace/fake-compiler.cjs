const fs = require("node:fs");
const path = require("node:path");

const sourcePath = process.argv[process.argv.length - 1];
const source = fs.readFileSync(sourcePath, "utf8");
const sourceName = path.basename(sourcePath);
const countFileIndex = process.argv.indexOf("--count-file");

if (countFileIndex >= 0) {
  const countFile = process.argv[countFileIndex + 1];
  if (!countFile) {
    process.stderr.write(`${sourcePath}:1:1: error: --count-file requires a path\n`);
    process.exit(1);
  }
  fs.appendFileSync(countFile, "compile\n", "utf8");
}

if (source.includes("SLEEP_FOREVER")) {
  setInterval(() => undefined, 1000);
  return;
}

if (source.includes("HEADER_ERROR")) {
  process.stderr.write(`${path.join(path.dirname(sourcePath), "common.h")}:1:1: error: shared header issue from ${sourceName}\n`);
  process.exit(1);
}

const expectedArgs = [...source.matchAll(/EXPECT_ARG:([^\s]+)/gu)].map((match) => match[1]);
for (const expectedArg of expectedArgs) {
  if (!process.argv.includes(expectedArg)) {
    process.stderr.write(`${sourcePath}:1:1: error: missing expected arg ${expectedArg}\n`);
    process.exit(1);
  }
}

if (!source.includes("square") && !source.includes("return 1") && expectedArgs.length === 0) {
  process.stderr.write(`${sourcePath}:1:1: error: expected fixture source\n`);
  process.exit(1);
}

process.stdout.write([
  ".text",
  ".globl square",
  "square:",
  "  movl $4, %eax # fake compiler marker",
  "  retq",
  ""
].join("\n"));
