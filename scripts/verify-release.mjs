import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yauzl from "yauzl";
import {
  validateCliVersion,
  validatePackageMetadata,
  validatePackedNpmArtifact,
  validateVsixArtifact,
} from "./release-integrity.mjs";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const packageDirectories = {
  core: join(repositoryRoot, "packages", "core"),
  cli: join(repositoryRoot, "packages", "cli"),
  vscode: join(repositoryRoot, "packages", "vscode"),
};

async function main() {
  await cleanGeneratedState();
  await runNpm(["run", "build"], repositoryRoot);

  const [core, cli, vscode, lockfile] = await Promise.all([
    readJson(join(packageDirectories.core, "package.json")),
    readJson(join(packageDirectories.cli, "package.json")),
    readJson(join(packageDirectories.vscode, "package.json")),
    readJson(join(repositoryRoot, "package-lock.json")),
  ]);

  validatePackageMetadata(core, "@agentcheck/core");
  validateCliMetadata(cli);
  validateVsCodeMetadata(vscode);
  validateWorkspaceLockfile(lockfile, { core, cli, vscode });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "agentcheck-release-"));
  try {
    const artifactsDirectory = join(temporaryRoot, "artifacts");
    const stagedPackages = join(temporaryRoot, "packages");
    const coreTarball = await packPackage(packageDirectories.core, stagedPackages, artifactsDirectory);
    const cliTarball = await packPackage(packageDirectories.cli, stagedPackages, artifactsDirectory);

    await verifyCoreInstall(coreTarball, temporaryRoot);
    await verifyCliInstall(cli, coreTarball, cliTarball, temporaryRoot);
    await verifyVsix(vscode, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log("Release integrity: PASS");
  console.log("  Core package: packed and imported locally");
  console.log("  CLI package: packed, installed locally, and ran --version");
  console.log("  VS Code package: VSIX structure and manifest validated");
}

async function cleanGeneratedState() {
  for (const directory of Object.values(packageDirectories)) {
    for (const generatedPath of ["dist", ".test-dist", "tsconfig.tsbuildinfo", "tsconfig.test.tsbuildinfo"]) {
      await rm(join(directory, generatedPath), { recursive: true, force: true });
    }
  }
}

function validateCliMetadata(cli) {
  if (cli.name !== "@agentcheck/cli") fail("CLI", "package name must be @agentcheck/cli.");
  if (!isVersion(cli.version)) fail("CLI", "package.json version must be a valid semantic version.");
  if (!isRecord(cli.bin) || typeof cli.bin.agentcheck !== "string" || cli.bin.agentcheck.length === 0) {
    fail("CLI", "package.json must declare a non-empty agentcheck bin path.");
  }
  if (!Array.isArray(cli.files) || !cli.files.includes("dist")) fail("CLI", "package.json files must include dist.");
}

function validateVsCodeMetadata(vscode) {
  if (vscode.name !== "agentcheck-vscode") fail("VS Code", "package name must be agentcheck-vscode.");
  if (!isVersion(vscode.version)) fail("VS Code", "package.json version must be a valid semantic version.");
  if (typeof vscode.main !== "string" || vscode.main.length === 0) fail("VS Code", "package.json must declare main.");
  if (!Array.isArray(vscode.contributes?.commands) || vscode.contributes.commands.length === 0) {
    fail("VS Code", "package.json must contribute at least one command.");
  }
}

function validateWorkspaceLockfile(lockfile, { core, cli, vscode }) {
  if (!isRecord(lockfile.packages)) fail("lockfile", "package-lock.json packages map is missing.");
  for (const [path, pkg] of [["packages/core", core], ["packages/cli", cli], ["packages/vscode", vscode]]) {
    const lockEntry = lockfile.packages[path];
    if (!isRecord(lockEntry) || lockEntry.name !== pkg.name || lockEntry.version !== pkg.version) {
      fail("lockfile", `${path} must match its package.json name and version.`);
    }
  }
  if (cli.dependencies?.[core.name] !== core.version) {
    fail("CLI", `declared ${core.name} dependency must match the Core package version.`);
  }
  if (lockfile.packages["packages/cli"].dependencies?.[core.name] !== core.version) {
    fail("lockfile", "packages/cli Core dependency must match the Core package version.");
  }
  if (lockfile.packages["packages/vscode"].devDependencies?.[core.name] !== vscode.devDependencies?.[core.name]) {
    fail("lockfile", "packages/vscode Core development dependency must match package.json.");
  }
}

async function packPackage(sourceDirectory, stagedPackages, artifactsDirectory) {
  const packageName = basename(sourceDirectory);
  const stagedDirectory = join(stagedPackages, packageName);
  await mkdir(stagedPackages, { recursive: true });
  await mkdir(artifactsDirectory, { recursive: true });
  await cp(sourceDirectory, stagedDirectory, { recursive: true, filter: (source) => !source.includes(".test-dist") });
  await cp(join(repositoryRoot, "LICENSE"), join(stagedDirectory, "LICENSE"));
  await runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", artifactsDirectory], stagedDirectory);
  const tarballs = await readdir(artifactsDirectory);
  const tarball = tarballs.find((entry) => entry.endsWith(".tgz") && entry.includes(packageName));
  if (!tarball) fail(packageName, "npm pack did not produce a tarball.");
  const packed = JSON.parse((await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], stagedDirectory)).stdout);
  const manifest = await readJson(join(stagedDirectory, "package.json"));
  validatePackedNpmArtifact(manifest, packed[0]?.files?.map((file) => file.path) ?? []);
  return join(artifactsDirectory, tarball);
}

async function verifyCoreInstall(coreTarball, temporaryRoot) {
  const installDirectory = join(temporaryRoot, "core-install");
  await mkdir(installDirectory, { recursive: true });
  await writeJson(join(installDirectory, "package.json"), { private: true, type: "module" });
  await runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", coreTarball], installDirectory);
  await writeFile(join(installDirectory, "smoke.mjs"), "import '@agentcheck/core';\n");
  await runCommand(process.execPath, ["smoke.mjs"], installDirectory);
}

async function verifyCliInstall(cli, coreTarball, cliTarball, temporaryRoot) {
  const installDirectory = join(temporaryRoot, "cli-install");
  await mkdir(installDirectory, { recursive: true });
  await writeJson(join(installDirectory, "package.json"), { private: true });
  await runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", coreTarball, cliTarball], installDirectory);
  const executable = join(installDirectory, "node_modules", ".bin", process.platform === "win32" ? "agentcheck.cmd" : "agentcheck");
  await access(executable);
  const result = await runNpm(["exec", "--offline", "--", "agentcheck", "--version"], installDirectory);
  validateCliVersion(cli, result.stdout.trim());
}

async function verifyVsix(vscode, temporaryRoot) {
  const vsce = join(repositoryRoot, "node_modules", "@vscode", "vsce", "vsce");
  const vsixPath = join(temporaryRoot, `${vscode.name}-${vscode.version}.vsix`);
  await runCommand(process.execPath, [vsce, "package", "--no-dependencies", "--out", vsixPath], packageDirectories.vscode);
  const entries = await listZipEntries(vsixPath);
  validateVsixArtifact(vscode, entries);
  const manifest = JSON.parse(await readZipEntry(vsixPath, "extension/package.json"));
  if (manifest.name !== vscode.name || manifest.version !== vscode.version || manifest.main !== vscode.main) {
    fail("VS Code", "VSIX manifest must match package.json name, version, and main entrypoint.");
  }
}

async function listZipEntries(zipPath) {
  return new Promise((resolveEntries, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.readEntry();
      zip.on("entry", (entry) => {
        entries.push(entry.fileName);
        zip.readEntry();
      });
      zip.once("end", () => resolveEntries(entries));
      zip.once("error", reject);
    });
  });
}

async function readZipEntry(zipPath, wantedPath) {
  return new Promise((resolveEntry, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.readEntry();
      zip.on("entry", (entry) => {
        if (entry.fileName !== wantedPath) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.once("end", () => resolveEntry(Buffer.concat(chunks).toString("utf8")));
          stream.once("error", reject);
        });
      });
      zip.once("end", () => reject(new Error(`VSIX entry ${wantedPath} was not found.`)));
      zip.once("error", reject);
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runNpm(argumentsList, cwd) {
  if (typeof npmCli !== "string" || npmCli.length === 0) {
    throw new Error("Release integrity requires npm_execpath to invoke npm without a shell wrapper.");
  }
  return runCommand(process.execPath, [npmCli, ...argumentsList], cwd);
}

async function runCommand(command, argumentsList, cwd) {
  try {
    return await run(command, argumentsList, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Release integrity command failed: ${command} ${argumentsList.join(" ")}\n${detail}`, { cause: error });
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function fail(scope, message) {
  throw new Error(`${scope}: ${message}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
