import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = process.cwd();
const packageJsonPath = resolve(packageRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

if (packageJson.name !== "@agentcheck/cli") {
  throw new Error(`Expected @agentcheck/cli package, found ${packageJson.name ?? "unnamed package"}.`);
}

const binPath = packageJson.bin?.agentcheck;
if (typeof binPath !== "string" || binPath.length === 0) {
  throw new Error("package.json bin.agentcheck must be a non-empty path.");
}

const resolvedBinPath = resolve(packageRoot, binPath);
const relativeBinPath = relative(packageRoot, resolvedBinPath);
if (isAbsolute(relativeBinPath) || relativeBinPath === ".." || relativeBinPath.startsWith(`..${sep}`)) {
  throw new Error(`package.json bin.agentcheck resolves outside the package: ${binPath}`);
}

const binFile = await stat(resolvedBinPath).catch(() => null);
if (!binFile?.isFile()) {
  throw new Error(`CLI entrypoint does not exist: ${binPath}`);
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is unavailable; run this check through npm.");
}

const { stdout } = await execFileAsync(
  process.execPath,
  [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: packageRoot, encoding: "utf8", windowsHide: true },
);
const [packResult] = JSON.parse(stdout);
const normalizedBinPath = binPath.replaceAll("\\", "/").replace(/^\.\//, "");
const packagedFiles = packResult?.files;

if (!Array.isArray(packagedFiles) || !packagedFiles.some((file) => file.path === normalizedBinPath)) {
  throw new Error(`npm package does not include CLI entrypoint: ${normalizedBinPath}`);
}

console.log(`Verified ${normalizedBinPath} in ${packResult.filename}.`);
