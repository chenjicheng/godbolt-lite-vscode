import * as path from "node:path";

const cSourceExtensions = new Set([".c"]);
const cxxSourceExtensions = new Set([".cc", ".cpp", ".cxx", ".c++", ".m", ".mm"]);
const cxxHeaderExtensions = new Set([".hh", ".hpp", ".hxx", ".h++"]);
const cFamilyHeaderExtensions = new Set([".h", ".hh", ".hpp", ".hxx", ".h++", ".inc"]);

export function parseCompileFlagsText(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function chooseInferredCompileCommandPath(sourcePath: string, candidatePaths: string[]): string | undefined {
  if (!isHeaderPath(sourcePath)) return undefined;
  const candidates = candidatePaths
    .filter((candidate) => isSourcePath(candidate))
    .map((candidate) => ({
      candidate,
      score: inferredHeaderScore(sourcePath, candidate)
    }))
    .sort((left, right) => compareScore(left.score, right.score));
  return candidates[0]?.candidate;
}

export function parseCompilationCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping: "\\" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      current += char;
      escaping = undefined;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (shouldEscapeNextCharacter(quote, next)) {
        escaping = "\\";
        continue;
      }
      current += char;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

export function sanitizeCompileCommandArgs(argv: string[], sourcePath: string, directory: string): string[] {
  const out: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "-c" || arg === "/c" || arg === "-S" || arg === "-E") continue;
    if (arg === "--") continue;
    if (arg === "-o" || arg === "--output" || arg === "-MF" || arg === "-MT" || arg === "-MQ" || arg === "-MJ") {
      index += 1;
      continue;
    }
    if (
      arg.startsWith("-o") ||
      arg.startsWith("--output=") ||
      arg.startsWith("-MF") ||
      arg.startsWith("-MT") ||
      arg.startsWith("-MQ") ||
      arg.startsWith("-MJ")
    ) {
      continue;
    }
    if (arg === "-M" || arg === "-MM" || arg === "-MD" || arg === "-MMD" || arg === "-MP" || arg === "-MG") {
      continue;
    }
    if (arg === "-emit-llvm") continue;
    if (sameCompileInputArg(arg, next, sourcePath, directory)) continue;
    out.push(arg);
  }
  return out;
}

function shouldEscapeNextCharacter(quote: "'" | "\"" | undefined, next: string | undefined): boolean {
  if (!next) return false;
  if (quote === "'") return false;
  if (quote === "\"") return next === "\"" || next === "\\";
  return /\s/u.test(next) || next === "\"" || next === "'" || next === "\\";
}

function sameCompileInputArg(arg: string, next: string | undefined, sourcePath: string, directory: string): boolean {
  if (arg === "--") return false;
  if (arg.startsWith("-")) return false;
  const candidate = path.isAbsolute(arg) ? arg : path.resolve(directory, arg);
  if (sameFsPath(candidate, sourcePath)) return true;
  return Boolean(next && !next.startsWith("-") && sameFsPath(path.resolve(candidate, next), sourcePath));
}

export function sameFsPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function isHeaderPath(filePath: string): boolean {
  return cFamilyHeaderExtensions.has(path.extname(filePath).toLowerCase());
}

function isSourcePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return cSourceExtensions.has(ext) || cxxSourceExtensions.has(ext);
}

function inferredHeaderScore(headerPath: string, candidatePath: string): number[] {
  const headerStem = path.basename(headerPath, path.extname(headerPath)).toLowerCase();
  const candidateStem = path.basename(candidatePath, path.extname(candidatePath)).toLowerCase();
  return [
    headerStem === candidateStem ? 0 : 1,
    languagePenalty(headerPath, candidatePath),
    directoryDistance(path.dirname(headerPath), path.dirname(candidatePath)),
    candidatePath.length
  ];
}

function languagePenalty(headerPath: string, candidatePath: string): number {
  const headerExt = path.extname(headerPath).toLowerCase();
  const candidateExt = path.extname(candidatePath).toLowerCase();
  if (cxxHeaderExtensions.has(headerExt)) return cxxSourceExtensions.has(candidateExt) ? 0 : 1;
  return 0;
}

function directoryDistance(leftDir: string, rightDir: string): number {
  const left = path.resolve(leftDir).split(/[\\/]+/u);
  const right = path.resolve(rightDir).split(/[\\/]+/u);
  let shared = 0;
  while (shared < left.length && shared < right.length && pathSegmentEqual(left[shared], right[shared])) {
    shared += 1;
  }
  return (left.length - shared) + (right.length - shared);
}

function pathSegmentEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function compareScore(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
