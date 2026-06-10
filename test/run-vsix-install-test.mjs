import { download, runTests, runVSCodeCommand } from "@vscode/test-electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(dirname, "..");
const workspaceFolder = path.join(extensionDevelopmentPath, "test", "fixtures", "workspace");
const extensionTestsPath = path.join(extensionDevelopmentPath, "out", "test", "installed", "index.js");
const manifest = JSON.parse(await fs.readFile(path.join(extensionDevelopmentPath, "package.json"), "utf8"));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const version = commandLineValue("--version") ?? process.env.VSCODE_TEST_VERSION ?? "stable";
const timeout = Number.parseInt(process.env.VSCODE_TEST_DOWNLOAD_TIMEOUT_MS ?? "60000", 10);
const vsixPath = path.resolve(extensionDevelopmentPath, commandLineValue("--vsix") ?? `${manifest.name}-${manifest.version}.vsix`);
const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "godbolt-lite-vsix-"));
const extensionsDir = path.join(profileRoot, "extensions");
const userDataDir = path.join(profileRoot, "user-data");

try {
  await assertFile(vsixPath);
  const vscodeExecutablePath = await download({ version, timeout });
  if (process.platform === "win32") {
    await isolateWindowsTestMutex(vscodeExecutablePath);
  }
  await runVSCodeCommand([
    "--install-extension",
    vsixPath,
    "--force",
    `--extensions-dir=${extensionsDir}`,
    `--user-data-dir=${userDataDir}`
  ], { version });
  const { stdout } = await runVSCodeCommand([
    "--list-extensions",
    `--extensions-dir=${extensionsDir}`,
    `--user-data-dir=${userDataDir}`
  ], { version });
  const installed = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!installed.includes(extensionId.toLowerCase())) {
    throw new Error(`Expected ${extensionId} in installed extensions, got: ${installed.join(", ")}`);
  }
  const installedExtensionPath = await findInstalledExtensionPath(extensionsDir, extensionId);
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: installedExtensionPath,
    extensionTestsPath,
    launchArgs: [
    workspaceFolder,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir
    ]
  });
  console.log(`Installed and ran ${extensionId} from ${path.basename(vsixPath)} in an isolated VS Code profile.`);
} finally {
  await fs.rm(profileRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function assertFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(`VSIX not found: ${filePath}`);
}

async function findInstalledExtensionPath(root, extensionId) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    const candidateManifest = await readJson(path.join(candidate, "package.json"));
    if (`${candidateManifest.publisher}.${candidateManifest.name}`.toLowerCase() === extensionId.toLowerCase()) {
      return candidate;
    }
  }
  throw new Error(`Could not find installed extension directory for ${extensionId} under ${root}`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

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

function commandLineValue(name) {
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) return process.argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}
