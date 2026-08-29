import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "..", "..");
const extensionTestsPath = join(packageDirectory, "dist", "extension-host-test.cjs");
const codeExecutable = await officialCodeExecutable();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentcheck-vscode-host-"));
const workspaceDirectory = join(temporaryDirectory, "workspace");
const userDataDirectory = join(temporaryDirectory, "user-data");
const extensionsDirectory = join(temporaryDirectory, "extensions");

try {
  await mkdir(workspaceDirectory);
  await mkdir(userDataDirectory);
  await mkdir(extensionsDirectory);
  await git(workspaceDirectory, ["init", "--initial-branch=main", "--quiet"]);
  await git(workspaceDirectory, ["config", "user.name", "AgentCheck VS Code Test"]);
  await git(workspaceDirectory, ["config", "user.email", "agentcheck-vscode-test@example.invalid"]);

  await run(codeExecutable, [
    "--new-window",
    "--disable-gpu",
    `--user-data-dir=${userDataDirectory}`,
    `--extensions-dir=${extensionsDirectory}`,
    `--extensionDevelopmentPath=${packageDirectory}`,
    `--extensionTestsPath=${extensionTestsPath}`,
    workspaceDirectory,
  ]);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function officialCodeExecutable() {
  if (process.env.VSCODE_EXECUTABLE_PATH) return process.env.VSCODE_EXECUTABLE_PATH;
  if (process.platform === "win32") {
    const installedPath = "C:\\Program Files\\Microsoft VS Code\\Code.exe";
    try {
      await access(installedPath, constants.X_OK);
      return installedPath;
    } catch {
      // Fall through to the explicit, portable setup instruction below.
    }
  }
  throw new Error("Set VSCODE_EXECUTABLE_PATH to an official Visual Studio Code executable before running the extension-host test.");
}

function git(cwd, args) {
  return run("git", args, { cwd });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`));
    });
  });
}
