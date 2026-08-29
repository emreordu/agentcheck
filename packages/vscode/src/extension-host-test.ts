import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { FileChange, ReviewResult } from "@agentcheck/core";
import * as vscode from "vscode";

const FIXTURE_DIRECTORY = "checkpoint-diff-fixtures";
const SENTINEL = "AGENTCHECK_M33_SOURCE_SENTINEL_7b4a";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("agentcheck.agentcheck-vscode");
  assert.ok(extension, "The AgentCheck extension was not discovered.");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "agentcheck.createCheckpoint",
    "agentcheck.reviewChanges",
    "agentcheck.showFindings",
    "agentcheck.clearCheckpoint",
    "agentcheck.openCheckpointDiff",
  ]) {
    assert.ok(commands.includes(command), `${command} was not registered.`);
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "The extension host smoke test requires one workspace folder.");
  await createCommittedFixture(folder.uri);

  const sample = fixtureUri(folder.uri, "sample.txt");
  await writeText(sample, "value = 2\n");
  assert.equal(await vscode.commands.executeCommand<boolean>("agentcheck.createCheckpoint"), true);

  await writeText(sample, "value = 3\n");
  await writeText(fixtureUri(folder.uri, "modified.txt"), "modified after\n");
  await writeText(fixtureUri(folder.uri, "created.txt"), `${SENTINEL}\ncreated content\n`);
  await vscode.workspace.fs.delete(fixtureUri(folder.uri, "deleted.txt"));
  await vscode.workspace.fs.rename(fixtureUri(folder.uri, "old-name.txt"), fixtureUri(folder.uri, "new-name.txt"));
  await writeText(fixtureUri(folder.uri, "new-name.txt"), renameContent("after"));
  await vscode.workspace.fs.writeFile(fixtureUri(folder.uri, "binary.bin"), Buffer.from([1, 0, 2]));
  await vscode.workspace.fs.writeFile(fixtureUri(folder.uri, "invalid-utf8.bin"), Buffer.from([0xff]));
  await vscode.workspace.fs.writeFile(fixtureUri(folder.uri, "oversized.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 65));

  const review = await vscode.commands.executeCommand<ReviewResult | undefined>("agentcheck.reviewChanges");
  assert.ok(review, "Review Changes did not return a result.");
  assert.equal(await gitText(folder.uri.fsPath, ["show", `HEAD:${FIXTURE_DIRECTORY}/sample.txt`]), "value = 1");
  assert.ok(!JSON.stringify(review).includes(SENTINEL), "The review result leaked source content.");

  const modified = requiredChange(review, "modified", "sample.txt");
  const created = requiredChange(review, "created", "created.txt");
  const deleted = requiredChange(review, "deleted", "deleted.txt");
  const renamed = requiredChange(review, "renamed", "new-name.txt");

  const critical = await openAndReadDiff(modified);
  assert.equal(critical.leftText, "value = 2\n", "Checkpoint content must preserve the pre-checkpoint dirty state.");
  assert.equal(critical.rightText, "value = 3\n");
  assert.equal(critical.leftUri.scheme, "agentcheck-checkpoint");
  assert.equal(critical.rightUri.scheme, "agentcheck-current");
  assert.doesNotMatch(`${critical.leftUri}\n${critical.rightUri}`, new RegExp(SENTINEL));

  await assertDiff(created, "", `${SENTINEL}\ncreated content\n`);
  await assertDiff(deleted, "deleted before\n", "");
  await assertDiff(renamed, renameContent("before"), renameContent("after"));

  const activeBeforeUnsupported = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  for (const change of [
    requiredChange(review, "created", "binary.bin"),
    requiredChange(review, "created", "invalid-utf8.bin"),
    requiredChange(review, "created", "oversized.txt"),
  ]) {
    await vscode.commands.executeCommand("agentcheck.openCheckpointDiff", change);
    await delay(100);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input, activeBeforeUnsupported, "Unsupported content must not open a text diff.");
  }

  await writeText(sample, "value = 4\n");
  const activeBeforeStaleFile = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  await vscode.commands.executeCommand("agentcheck.openCheckpointDiff", modified);
  await delay(100);
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input, activeBeforeStaleFile, "A file changed after review must not open a stale diff.");

  assert.equal(await vscode.commands.executeCommand<boolean>("agentcheck.clearCheckpoint"), true);
  const activeBeforeClearedCheckpoint = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  await vscode.commands.executeCommand("agentcheck.openCheckpointDiff", modified);
  await delay(100);
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input, activeBeforeClearedCheckpoint, "A cleared checkpoint must not open an old diff.");
}

async function createCommittedFixture(workspace: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(fixtureUri(workspace));
  await writeText(fixtureUri(workspace, "sample.txt"), "value = 1\n");
  await writeText(fixtureUri(workspace, "modified.txt"), "modified before\n");
  await writeText(fixtureUri(workspace, "deleted.txt"), "deleted before\n");
  await writeText(fixtureUri(workspace, "old-name.txt"), renameContent("before"));
  await git(workspace.fsPath, ["add", "--", FIXTURE_DIRECTORY]);
  await git(workspace.fsPath, ["commit", "-m", "checkpoint diff fixture", "--quiet"]);
}

function fixtureUri(workspace: vscode.Uri, name = ""): vscode.Uri {
  return name ? vscode.Uri.joinPath(workspace, FIXTURE_DIRECTORY, name) : vscode.Uri.joinPath(workspace, FIXTURE_DIRECTORY);
}

function requiredChange(review: ReviewResult, type: FileChange["type"], suffix: string): FileChange {
  const change = review.changes.files.find((candidate) => candidate.type === type && candidate.path.endsWith(suffix));
  assert.ok(change, `Missing ${type} change for ${suffix}.`);
  return change;
}

async function assertDiff(change: FileChange, left: string, right: string): Promise<void> {
  const result = await openAndReadDiff(change);
  assert.equal(result.leftText, left);
  assert.equal(result.rightText, right);
}

async function openAndReadDiff(change: FileChange): Promise<{ leftUri: vscode.Uri; rightUri: vscode.Uri; leftText: string; rightText: string }> {
  await vscode.commands.executeCommand("agentcheck.openCheckpointDiff", change);
  const input = await activeDiffInput();
  const [left, right] = await Promise.all([
    vscode.workspace.openTextDocument(input.original),
    vscode.workspace.openTextDocument(input.modified),
  ]);
  return {
    leftUri: input.original,
    rightUri: input.modified,
    leftText: left.getText(),
    rightText: right.getText(),
  };
}

async function activeDiffInput(): Promise<vscode.TabInputTextDiff> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) return input;
    await delay(50);
  }
  throw new Error("The native VS Code diff editor did not become active.");
}

function renameContent(lastLine: string): string {
  return `${Array.from({ length: 10 }, (_, index) => `shared ${index + 1}`).join("\n")}\n${lastLine}\n`;
}

function writeText(uri: vscode.Uri, value: string): Thenable<void> {
  return vscode.workspace.fs.writeFile(uri, Buffer.from(value));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message, { cause: error }));
        return;
      }
      resolvePromise();
    });
  });
}

function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message, { cause: error }));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}