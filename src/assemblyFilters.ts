export type AssemblyFilterOptions = {
  readonly trimMetadataDirectives: boolean;
  readonly trimComments: boolean;
  readonly trimBlankLines: boolean;
};

const metadataDirectivePattern = /^\s*\.(?:addrsig|addrsig_sym|cfi_[\w.]+|cv_[\w.]+|debug_[\w.]+|def|endef|file|ident|loc|section|seh_[\w.]+|size|type|weak|weak_definition)\b/u;

export function filterAssembly(assembly: string, options: AssemblyFilterOptions): string {
  const lines: string[] = [];
  let previousBlank = false;

  for (const line of assembly.split(/\r?\n/u)) {
    if (options.trimMetadataDirectives && shouldDropMetadataDirective(line)) continue;
    let next = options.trimComments ? trimAssemblyComment(line) : line;
    if (options.trimBlankLines && next.trim().length === 0) {
      if (previousBlank) continue;
      previousBlank = true;
      next = "";
    } else {
      previousBlank = false;
    }
    lines.push(next);
  }

  return lines.join("\n").trimEnd();
}

function shouldDropMetadataDirective(line: string): boolean {
  return metadataDirectivePattern.test(line);
}

function trimAssemblyComment(line: string): string {
  const marker = commentMarkerIndex(line);
  if (marker < 0) return line;
  return line.slice(0, marker).trimEnd();
}

function commentMarkerIndex(line: string): number {
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" || char === ";") return index;
    if (char === "/" && line[index + 1] === "/") return index;
  }
  return -1;
}
