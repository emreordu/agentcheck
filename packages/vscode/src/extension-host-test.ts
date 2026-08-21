import assert from "node:assert/strict";
import type { ReviewResult } from "@agentcheck/core";
import * as vscode from "vscode";

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
  ]) {
    assert.ok(commands.includes(command), `${command} was not registered.`);
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "The extension host smoke test requires one workspace folder.");

  assert.equal(
    await vscode.commands.executeCommand<boolean>("agentcheck.createCheckpoint"),
    true,
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(folder.uri, "appsettings.Production.json"),
    Buffer.from(`${JSON.stringify({ featureEnabled: true, smokeRun: Date.now() })}\n`),
  );

  const review = await vscode.commands.executeCommand<ReviewResult | undefined>(
    "agentcheck.reviewChanges",
  );
  assert.ok(review, "Review Changes did not return a result.");
  assert.equal(review.changes.files.length, 1);
  assert.ok(
    review.findings.some((finding) => finding.title === "Production configuration changed"),
  );
  assert.equal(await vscode.commands.executeCommand<boolean>("agentcheck.showFindings"), true);
  await vscode.commands.executeCommand(
    "agentcheck.openFile",
    "appsettings.Production.json",
    folder.uri.fsPath,
    folder.uri.fsPath,
  );
  assert.equal(
    vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(),
    vscode.Uri.joinPath(folder.uri, "appsettings.Production.json").fsPath.toLowerCase(),
  );
  assert.equal(await vscode.commands.executeCommand<boolean>("agentcheck.clearCheckpoint"), true);
}
