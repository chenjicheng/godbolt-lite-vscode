import { download, runTests } from "@vscode/test-electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(dirname, "..");
const workspaceFolder = path.join(extensionDevelopmentPath, "test", "fixtures", "workspace");
const extensionTestsPath = path.join(extensionDevelopmentPath, "out", "test", "suite", "index.js");
const version = commandLineVersion() ?? process.env.VSCODE_TEST_VERSION ?? "stable";
const timeout = Number.parseInt(process.env.VSCODE_TEST_DOWNLOAD_TIMEOUT_MS ?? "60000", 10);
const vscodeExecutablePath = await download({ version, timeout });

if (process.platform === "win32") {
  await isolateWindowsTestMutex(vscodeExecutablePath);
}

await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: [
    workspaceFolder,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--user-data-dir",
    path.join(extensionDevelopmentPath, ".vscode-test", "user-data"),
    "--extensions-dir",
    path.join(extensionDevelopmentPath, ".vscode-test", "extensions")
  ]
});

async function isolateWindowsTestMutex(vscodeExecutablePath) {
  const productJsonPath = await findProductJsonPath(path.dirname(vscodeExecutablePath));
  const relativeProductPath = path.relative(path.join(extensionDevelopmentPath, ".vscode-test"), productJsonPath);
  if (relativeProductPath.startsWith("..") || path.isAbsolute(relativeProductPath)) {
    throw new Error(`Refusing to modify VS Code product.json outside .vscode-test: ${productJsonPath}`);
  }
  const product = JSON.parse(await fs.readFile(productJsonPath, "utf8"));
  if (product.win32MutexName === "godbolt-lite-vscode-test") return;
  product.win32MutexName = "godbolt-lite-vscode-test";
  await fs.writeFile(productJsonPath, `${JSON.stringify(product, null, "\t")}\n`);
}

async function findProductJsonPath(root) {
  const direct = path.join(root, "resources", "app", "product.json");
  if (await fileExists(direct)) return direct;

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, "resources", "app", "product.json");
    if (await fileExists(candidate)) return candidate;
  }

  throw new Error(`Could not find VS Code product.json under ${root}`);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function commandLineVersion() {
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--version") return process.argv[index + 1];
    if (arg.startsWith("--version=")) return arg.slice("--version=".length);
  }
  return undefined;
}
