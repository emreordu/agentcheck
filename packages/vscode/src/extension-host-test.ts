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

  const fakeCredential = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, "src"));

  assert.equal(
    await vscode.commands.executeCommand<boolean>("agentcheck.createCheckpoint"),
    true,
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(folder.uri, "appsettings.Production.json"),
    Buffer.from(`${JSON.stringify({ api_key: fakeCredential, featureEnabled: true, smokeRun: Date.now() })}\n`),
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(folder.uri, "src", "OrderService.ts"),
    Buffer.from("export const reviewed = true;\n"),
  );

  const review = await vscode.commands.executeCommand<ReviewResult | undefined>(
    "agentcheck.reviewChanges",
  );
  assert.ok(review, "Review Changes did not return a result.");
  assert.equal(review.changes.files.length, 2);
  assert.ok(review.changes.files.some(({ path }) => path === "src/OrderService.ts"));
  assert.ok(
    review.findings.some((finding) => finding.title === "Production configuration changed"),
  );
  assert.ok(
    review.findings.some((finding) => finding.title === "Possible secret"),
  );
  assert.ok(review.findings.every((finding) => !finding.files.includes("src/OrderService.ts")));
  assert.ok(!JSON.stringify(review).includes(fakeCredential), "The fake credential leaked into the review result.");
  assert.equal(typeof review.risk.score, "number");
  assert.ok(["low", "medium", "high"].includes(review.risk.level));
  assert.ok(["LOOKS ROUTINE", "REVIEW RECOMMENDED", "CAREFUL REVIEW RECOMMENDED"].includes(review.verdict));
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
