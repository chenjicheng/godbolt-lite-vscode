import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { filterAssembly } = require("../out/assemblyFilters.js");

test("filterAssembly removes metadata directives and collapses blank lines", () => {
  const input = [
    '\t.file\t"main.c"',
    "\t.text",
    "",
    "",
    "square:",
    "\t.cfi_startproc",
    "\tmovl\t%ecx, %eax",
    "\t.cfi_endproc",
    "\t.ident\t\"clang\""
  ].join("\n");
  assert.equal(
    filterAssembly(input, {
      trimMetadataDirectives: true,
      trimComments: false,
      trimBlankLines: true
    }),
    ["\t.text", "", "square:", "\tmovl\t%ecx, %eax"].join("\n")
  );
});

test("filterAssembly can trim comments without touching string literals", () => {
  const input = [
    'label:\t.asciz "value # not comment"',
    "\tmovl\t%ecx, %eax # copy input",
    "\tretq ; done"
  ].join("\n");
  assert.equal(
    filterAssembly(input, {
      trimMetadataDirectives: false,
      trimComments: true,
      trimBlankLines: false
    }),
    ['label:\t.asciz "value # not comment"', "\tmovl\t%ecx, %eax", "\tretq"].join("\n")
  );
});
