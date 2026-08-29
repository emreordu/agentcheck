import {
  GitError,
  clearCheckpoint,
  createCheckpoint,
  loadCheckpoint,
  resolveRepository,
  reviewChanges,
  type FileChange,
  type Finding,
  type ReviewResult,
} from "@agentcheck/core";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import {
  CheckpointDiffReview,
  checkpointDiffTitle,
  type CheckpointDiffDocument,
} from "./checkpoint-diff-model.js";
import {
  buildReviewTree,
  changeLabel,
  checkpointStatus,
  childrenOf,
  reviewStatus,
  type FindingTreeNode,
  type ReviewPresentation,
} from "./findings-tree.js";

const COMMANDS = {
  createCheckpoint: "agentcheck.createCheckpoint",
  reviewChanges: "agentcheck.reviewChanges",
  showFindings: "agentcheck.showFindings",
  clearCheckpoint: "agentcheck.clearCheckpoint",
  openCheckpointDiff: "agentcheck.openCheckpointDiff",
} as const;

const CHECKPOINT_DOCUMENT_SCHEME = "agentcheck-checkpoint";
const CURRENT_DOCUMENT_SCHEME = "agentcheck-current";

class FindingsTreeProvider implements vscode.TreeDataProvider<FindingTreeNode> {
  readonly #changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changes.event;
  #review: ReviewPresentation | undefined;

  get hasReview(): boolean { return this.#review !== undefined; }

  update(result: ReviewResult): void {
    this.#review = result;
    this.#changes.fire();
  }

  clear(): void {
    this.#review = undefined;
    this.#changes.fire();
  }

  getChildren(element?: FindingTreeNode): FindingTreeNode[] {
    return element ? childrenOf(element) : this.#review ? buildReviewTree(this.#review) : [];
  }

  getTreeItem(element: FindingTreeNode): vscode.TreeItem {
    if (element.kind === "section") {
      const count = element.section === "changes"
        ? element.result.changes.files.length
        : element.section === "findings" ? element.result.findings.length : undefined;
      const label = count === undefined ? element.section.toUpperCase() : `${element.section.toUpperCase()} (${count})`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(sectionIcon(element.section));
      return item;
    }
    if (element.kind === "change") {
      const item = new vscode.TreeItem(changeLabel(element.change));
      item.iconPath = new vscode.ThemeIcon(changeIcon(element.change.type));
      item.contextValue = "agentcheck-change";
      item.command = checkpointDiffCommand(element.change);
      return item;
    }
    if (element.kind === "severity") {
      const item = new vscode.TreeItem(element.severity.toUpperCase(), vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(element.findings.length);
      item.iconPath = new vscode.ThemeIcon(severityIcon(element.severity));
      return item;
    }
    if (element.kind === "finding") {
      const item = new vscode.TreeItem(element.finding.title, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.finding.category;
      item.tooltip = new vscode.MarkdownString(`${escapeMarkdown(element.finding.title)}\n\n${escapeMarkdown(element.finding.description)}`);
      return item;
    }
    if (element.kind === "file") {
      const item = new vscode.TreeItem(element.path);
      item.description = "Affected file";
      item.iconPath = vscode.ThemeIcon.File;
      item.contextValue = "agentcheck-finding-file";
      item.command = checkpointDiffCommand({ path: element.path });
      return item;
    }
    if (element.kind === "detail") {
      const item = new vscode.TreeItem(element.label);
      item.description = element.value;
      item.tooltip = element.value;
      item.iconPath = new vscode.ThemeIcon("comment-discussion");
      return item;
    }
    if (element.kind === "evidence-group") {
      const item = new vscode.TreeItem("Evidence", vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(element.evidence.length);
      item.iconPath = new vscode.ThemeIcon("search");
      return item;
    }
    if (element.kind === "evidence") {
      const item = new vscode.TreeItem(element.value);
      item.tooltip = element.value;
      item.iconPath = new vscode.ThemeIcon("quote");
      return item;
    }
    if (element.kind === "risk-value") {
      const item = new vscode.TreeItem(element.label);
      item.description = element.value;
      item.iconPath = new vscode.ThemeIcon(element.label === "Score" ? "pulse" : "shield");
      return item;
    }
    const item = new vscode.TreeItem(element.value);
    item.iconPath = new vscode.ThemeIcon("verified");
    return item;
  }

  dispose(): void { this.#changes.dispose(); }
}

class CheckpointDiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #changes = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changes.event;
  readonly #servedUris = new Set<string>();
  #review: CheckpointDiffReview | undefined;
  #repositoryRoot: string | undefined;
  #workspaceRoot: string | undefined;

  update(result: ReviewResult, repositoryRoot: string, workspaceRoot: string): void {
    this.invalidate();
    this.#review = new CheckpointDiffReview(result);
    this.#repositoryRoot = repositoryRoot;
    this.#workspaceRoot = workspaceRoot;
  }

  clear(): void {
    this.invalidate();
    this.#review = undefined;
    this.#repositoryRoot = undefined;
    this.#workspaceRoot = undefined;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const document = this.documentForUri(uri);
    this.#servedUris.add(uri.toString());
    return this.requireReview().readText(document);
  }

  async open(target: unknown): Promise<void> {
    const review = this.#review;
    const change = review?.resolveChange(target);
    if (!review || !change || !this.#repositoryRoot || !this.#workspaceRoot) {
      void vscode.window.showWarningMessage("Run AgentCheck: Review Changes, then choose a changed or affected file.");
      return;
    }

    try {
      await this.validateReviewContext(review);
      const [checkpointDocument, currentDocument] = review.documentsFor(change);
      await Promise.all([review.readText(checkpointDocument), review.readText(currentDocument)]);
      if (await currentFileChangedSinceReview(this.#repositoryRoot, this.#workspaceRoot, currentDocument, review)) {
        void vscode.window.showWarningMessage("This file changed after the AgentCheck review. Refresh AgentCheck before opening its checkpoint diff.");
        return;
      }
      const left = this.uriFor(checkpointDocument);
      const right = this.uriFor(currentDocument);
      this.#servedUris.add(left.toString());
      this.#servedUris.add(right.toString());
      await vscode.commands.executeCommand("vscode.diff", left, right, checkpointDiffTitle(change));
    } catch (error) {
      void vscode.window.showWarningMessage(checkpointDiffFailure(error));
    }
  }

  dispose(): void {
    this.clear();
    this.#changes.dispose();
  }

  private async validateReviewContext(review: CheckpointDiffReview): Promise<void> {
    const folder = getSingleWorkspaceFolder();
    if (!folder) throw new Error("The AgentCheck workspace is no longer available.");
    const repository = await resolveRepository(folder.uri.fsPath);
    if (repository.root !== this.#repositoryRoot) {
      throw new Error("The active workspace is not the repository used for this AgentCheck review.");
    }
    const checkpoint = await loadCheckpoint(folder.uri.fsPath);
    if (checkpoint.tree !== review.result.checkpoint.tree) {
      throw new Error("The AgentCheck checkpoint changed after this review.");
    }
  }

  private uriFor(document: CheckpointDiffDocument): vscode.Uri {
    const scheme = document.side === "checkpoint" ? CHECKPOINT_DOCUMENT_SCHEME : CURRENT_DOCUMENT_SCHEME;
    return vscode.Uri.from({ scheme, authority: this.requireReview().id, path: `/${document.path}` });
  }

  private documentForUri(uri: vscode.Uri): CheckpointDiffDocument {
    const review = this.requireReview();
    if ((uri.scheme !== CHECKPOINT_DOCUMENT_SCHEME && uri.scheme !== CURRENT_DOCUMENT_SCHEME)
      || uri.authority !== review.id || !uri.path.startsWith("/")) {
      throw new Error("The requested document is not part of the active AgentCheck review.");
    }
    return { side: uri.scheme === CHECKPOINT_DOCUMENT_SCHEME ? "checkpoint" : "current", path: uri.path.slice(1) };
  }

  private requireReview(): CheckpointDiffReview {
    if (!this.#review) throw new Error("The AgentCheck review is no longer active. Run Review Changes again.");
    return this.#review;
  }

  private invalidate(): void {
    for (const value of this.#servedUris) this.#changes.fire(vscode.Uri.parse(value));
    this.#servedUris.clear();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const findings = new FindingsTreeProvider();
  const checkpointDiff = new CheckpointDiffProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "AgentCheck";
  status.command = COMMANDS.showFindings;
  setIdleStatus(status);
  status.show();

  context.subscriptions.push(
    findings, checkpointDiff, status,
    vscode.window.registerTreeDataProvider("agentcheck.findings", findings),
    vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_DOCUMENT_SCHEME, checkpointDiff),
    vscode.workspace.registerTextDocumentContentProvider(CURRENT_DOCUMENT_SCHEME, checkpointDiff),
    vscode.commands.registerCommand(COMMANDS.createCheckpoint, async () => {
      const folder = getSingleWorkspaceFolder();
      if (!folder) return false;
      try {
        const checkpoint = await createCheckpoint(folder.uri.fsPath);
        findings.clear(); checkpointDiff.clear(); applyStatus(status, checkpointStatus());
        void vscode.window.showInformationMessage(`AgentCheck checkpoint created. Branch: ${checkpoint.branch ?? "detached HEAD"}. Commit: ${checkpoint.head.slice(0, 7)}.`);
        return true;
      } catch (error) { showFailure("Could not create checkpoint.", error); return false; }
    }),
    vscode.commands.registerCommand(COMMANDS.reviewChanges, async () => {
      const folder = getSingleWorkspaceFolder();
      if (!folder) return undefined;
      try {
        const [result, repository] = await Promise.all([reviewChanges(folder.uri.fsPath), resolveRepository(folder.uri.fsPath)]);
        findings.update(result); checkpointDiff.update(result, repository.root, folder.uri.fsPath); applyStatus(status, reviewStatus(result.risk.level));
        void vscode.commands.executeCommand("agentcheck.findings.focus");
        void vscode.window.showInformationMessage(`AgentCheck review complete: ${result.changes.files.length} changes, ${result.findings.length} findings, score ${result.risk.score} (${result.risk.level.toUpperCase()}).`);
        return result;
      } catch (error) { showFailure("Could not review changes.", error); return undefined; }
    }),
    vscode.commands.registerCommand(COMMANDS.showFindings, async () => {
      await vscode.commands.executeCommand("agentcheck.findings.focus");
      if (!findings.hasReview) void vscode.window.showInformationMessage("Run AgentCheck: Review Changes to populate the review.");
      return true;
    }),
    vscode.commands.registerCommand(COMMANDS.clearCheckpoint, async () => {
      const folder = getSingleWorkspaceFolder();
      if (!folder) return false;
      try {
        await clearCheckpoint(folder.uri.fsPath); findings.clear(); checkpointDiff.clear(); setIdleStatus(status);
        void vscode.window.showInformationMessage("AgentCheck checkpoint cleared."); return true;
      } catch (error) { showFailure("Could not clear checkpoint.", error); return false; }
    }),
    vscode.commands.registerCommand(COMMANDS.openCheckpointDiff, async (target: unknown) => checkpointDiff.open(target)),
  );
}

export function deactivate(): void {}

function getSingleWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { void vscode.window.showErrorMessage("AgentCheck requires an open folder containing a Git repository."); return undefined; }
  if (folders.length !== 1) { void vscode.window.showErrorMessage("AgentCheck v0.1 supports one repository workspace at a time."); return undefined; }
  return folders[0];
}

async function currentFileChangedSinceReview(repositoryRoot: string, workspaceRoot: string, document: CheckpointDiffDocument, review: CheckpointDiffReview): Promise<boolean> {
  const target = resolve(repositoryRoot, ...document.path.split("/"));
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const reviewedContent = await review.result.content.readAfter(document.path);
  try {
    const realTarget = await realpath(target);
    if (!isWithin(realWorkspaceRoot, realTarget)) throw new Error("The selected file is outside the current workspace.");
    const currentContent = await readFile(realTarget);
    return reviewedContent === null || !currentContent.equals(reviewedContent);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    if (!isWithin(resolve(workspaceRoot), target)) throw new Error("The selected file is outside the current workspace.");
    return reviewedContent !== null;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function checkpointDiffFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("A text diff is unavailable")) return message;
  if (message.toLowerCase().includes("no active agentcheck checkpoint")) return "The AgentCheck checkpoint is no longer active. Run AgentCheck: Review Changes after creating a checkpoint.";
  if (message.includes("checkpoint changed") || message.includes("workspace is not")) return `${message} Refresh AgentCheck and try again.`;
  if (message.includes("outside the current workspace")) return "AgentCheck cannot open a diff for a file outside the current workspace.";
  return "AgentCheck could not open the checkpoint diff. Refresh AgentCheck and try again.";
}

function showFailure(prefix: string, error: unknown): void { void vscode.window.showErrorMessage(`${prefix} ${friendlyError(error)}`); }
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error); const lower = message.toLowerCase();
  if (lower.includes("checkpoint already exists")) return "A checkpoint already exists. Clear it before creating another one.";
  if ((lower.includes("checkpoint") && lower.includes("not found")) || lower.includes("no active agentcheck checkpoint")) return "Create a checkpoint first.";
  if (lower.includes("not a git repository")) return "The open folder is not inside a Git repository.";
  if (lower.includes("unborn") || lower.includes("no commits")) return "The repository needs an initial commit before AgentCheck can run.";
  if ((error instanceof GitError && (lower.includes("enoent") || lower.includes("not recognized"))) || (error instanceof Error && "code" in error && error.code === "ENOENT")) return "Git is not available on PATH.";
  return "See the repository state and try again.";
}
function setIdleStatus(status: vscode.StatusBarItem): void { status.text = "$(shield) AgentCheck"; status.tooltip = "Run AgentCheck: Show Review"; }
function applyStatus(status: vscode.StatusBarItem, presentation: { text: string; tooltip: string }): void { status.text = presentation.text; status.tooltip = presentation.tooltip; }
function checkpointDiffCommand(target: FileChange | { path: string }): vscode.Command { return { command: COMMANDS.openCheckpointDiff, title: "Open checkpoint diff", arguments: [target] }; }
function sectionIcon(section: "changes" | "findings" | "risk" | "verdict"): string { if (section === "changes") return "files"; if (section === "findings") return "search"; if (section === "risk") return "shield"; return "verified"; }
function changeIcon(type: ReviewResult["changes"]["files"][number]["type"]): string { if (type === "created") return "diff-added"; if (type === "deleted") return "diff-removed"; if (type === "renamed") return "diff-renamed"; return "diff-modified"; }
function severityIcon(severity: Finding["severity"]): string { if (severity === "high") return "error"; if (severity === "warning") return "warning"; return "info"; }
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&"); }