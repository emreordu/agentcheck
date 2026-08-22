import {
  GitError,
  clearCheckpoint,
  createCheckpoint,
  resolveRepository,
  reviewChanges,
  type Finding,
  type ReviewResult,
} from "@agentcheck/core";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
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
  openFile: "agentcheck.openFile",
} as const;

class FindingsTreeProvider implements vscode.TreeDataProvider<FindingTreeNode> {
  readonly #changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changes.event;
  #review: ReviewPresentation | undefined;
  #repositoryRoot: string | undefined;
  #workspaceRoot: string | undefined;

  get hasReview(): boolean { return this.#review !== undefined; }

  update(result: ReviewResult, repositoryRoot: string, workspaceRoot: string): void {
    this.#review = result;
    this.#repositoryRoot = repositoryRoot;
    this.#workspaceRoot = workspaceRoot;
    this.#changes.fire();
  }

  clear(): void {
    this.#review = undefined;
    this.#repositoryRoot = undefined;
    this.#workspaceRoot = undefined;
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
      const label = count === undefined
        ? element.section.toUpperCase()
        : `${element.section.toUpperCase()} (${count})`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(sectionIcon(element.section));
      return item;
    }
    if (element.kind === "change") {
      const item = new vscode.TreeItem(changeLabel(element.change));
      item.iconPath = new vscode.ThemeIcon(changeIcon(element.change.type));
      if (element.change.type !== "deleted" && this.#repositoryRoot && this.#workspaceRoot) {
        item.command = openFileCommand(element.change.path, this.#repositoryRoot, this.#workspaceRoot);
      }
      return item;
    }
    if (element.kind === "severity") {
      const item = new vscode.TreeItem(element.severity.toUpperCase(), vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(element.findings.length);
      item.iconPath = new vscode.ThemeIcon(severityIcon(element.severity));
      return item;
    }
    if (element.kind === "finding") {
      const state = vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(element.finding.title, state);
      item.description = element.finding.category;
      item.tooltip = new vscode.MarkdownString(`${escapeMarkdown(element.finding.title)}\n\n${escapeMarkdown(element.finding.description)}`);
      return item;
    }

    if (element.kind === "file") {
      const item = new vscode.TreeItem(element.path);
      item.description = "Affected file";
      item.iconPath = vscode.ThemeIcon.File;
      if (this.#repositoryRoot && this.#workspaceRoot) {
        item.command = openFileCommand(element.path, this.#repositoryRoot, this.#workspaceRoot);
      }
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

export function activate(context: vscode.ExtensionContext): void {
  const findings = new FindingsTreeProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "AgentCheck";
  status.command = COMMANDS.showFindings;
  setIdleStatus(status);
  status.show();

  context.subscriptions.push(
    findings,
    status,
    vscode.window.registerTreeDataProvider("agentcheck.findings", findings),
    vscode.commands.registerCommand(COMMANDS.createCheckpoint, async () => {
      const folder = getSingleWorkspaceFolder();
      if (!folder) return false;
      try {
        const checkpoint = await createCheckpoint(folder.uri.fsPath);
        findings.clear();
        applyStatus(status, checkpointStatus());
        void vscode.window.showInformationMessage(
          `AgentCheck checkpoint created. Branch: ${checkpoint.branch ?? "detached HEAD"}. Commit: ${checkpoint.head.slice(0, 7)}.`,
        );
        return true;
      } catch (error) {
        showFailure("Could not create checkpoint.", error);
        return false;
      }
    }),
    vscode.commands.registerCommand(COMMANDS.reviewChanges, async () => {
      const folder = getSingleWorkspaceFolder();
      if (!folder) return undefined;
      try {
        const [result, repository] = await Promise.all([
          reviewChanges(folder.uri.fsPath),
          resolveRepository(folder.uri.fsPath),
        ]);
        findings.update(result, repository.root, folder.uri.fsPath);
        applyStatus(status, reviewStatus(result.risk.level));
        void vscode.commands.executeCommand("agentcheck.findings.focus");
        void vscode.window.showInformationMessage(
          `AgentCheck review complete: ${result.changes.files.length} changes, ${result.findings.length} findings, score ${result.risk.score} (${result.risk.level.toUpperCase()}).`,
        );
        return result;
      } catch (error) {
        showFailure("Could not review changes.", error);
        return undefined;
      }
    }),
    vscode.commands.registerCommand(COMMANDS.showFindings, async () => {
      await vscode.commands.executeCommand("agentcheck.findings.focus");
      if (!findings.hasReview) {
        void vscode.window.showInformationMessage("Run AgentCheck: Review Changes to populate the review.");
      }
      return true;
    }),
    vscode.commands.registerCommand(COMMANDS.clearCheckpoint, async () => {
      const folder = getSingleWorkspaceFolder();
      if (!folder) return false;
      try {
        await clearCheckpoint(folder.uri.fsPath);
        findings.clear();
        setIdleStatus(status);
        void vscode.window.showInformationMessage("AgentCheck checkpoint cleared.");
        return true;
      } catch (error) {
        showFailure("Could not clear checkpoint.", error);
        return false;
      }
    }),
    vscode.commands.registerCommand(COMMANDS.openFile, async (path: string, repositoryRoot: string, workspaceRoot: string) => {
      await openWorkspaceFile(path, repositoryRoot, workspaceRoot);
    }),
  );
}

export function deactivate(): void {}

function getSingleWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showErrorMessage("AgentCheck requires an open folder containing a Git repository.");
    return undefined;
  }
  if (folders.length !== 1) {
    void vscode.window.showErrorMessage("AgentCheck v0.1 supports one repository workspace at a time.");
    return undefined;
  }
  return folders[0];
}

async function openWorkspaceFile(repositoryRelativePath: string, repositoryRoot: string, workspaceRoot: string): Promise<void> {
  try {
    const target = resolve(repositoryRoot, ...repositoryRelativePath.split("/"));
    const [realWorkspaceRoot, realTarget] = await Promise.all([realpath(workspaceRoot), realpath(target)]);
    const fromWorkspace = relative(realWorkspaceRoot, realTarget);
    const outsideWorkspace = fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace);
    if (outsideWorkspace) {
      void vscode.window.showWarningMessage("AgentCheck cannot open a finding file outside the current workspace.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(realTarget);
    await vscode.window.showTextDocument(document);
  } catch {
    void vscode.window.showWarningMessage("AgentCheck could not open the finding file. It may have been deleted or moved.");
  }
}

function showFailure(prefix: string, error: unknown): void {
  void vscode.window.showErrorMessage(`${prefix} ${friendlyError(error)}`);
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("checkpoint already exists")) return "A checkpoint already exists. Clear it before creating another one.";
  if (
    (lower.includes("checkpoint") && lower.includes("not found")) ||
    lower.includes("no active agentcheck checkpoint")
  ) return "Create a checkpoint first.";
  if (lower.includes("not a git repository")) return "The open folder is not inside a Git repository.";
  if (lower.includes("unborn") || lower.includes("no commits")) return "The repository needs an initial commit before AgentCheck can run.";
  if (
    (error instanceof GitError && (lower.includes("enoent") || lower.includes("not recognized"))) ||
    (error instanceof Error && "code" in error && error.code === "ENOENT")
  ) return "Git is not available on PATH.";
  return "See the repository state and try again.";
}

function setIdleStatus(status: vscode.StatusBarItem): void {
  status.text = "$(shield) AgentCheck";
  status.tooltip = "Run AgentCheck: Show Review";
}

function applyStatus(status: vscode.StatusBarItem, presentation: { text: string; tooltip: string }): void {
  status.text = presentation.text;
  status.tooltip = presentation.tooltip;
}

function openFileCommand(path: string, repositoryRoot: string, workspaceRoot: string): vscode.Command {
  return {
    command: COMMANDS.openFile,
    title: "Open file",
    arguments: [path, repositoryRoot, workspaceRoot],
  };
}

function sectionIcon(section: "changes" | "findings" | "risk" | "verdict"): string {
  if (section === "changes") return "files";
  if (section === "findings") return "search";
  if (section === "risk") return "shield";
  return "verified";
}

function changeIcon(type: ReviewResult["changes"]["files"][number]["type"]): string {
  if (type === "created") return "diff-added";
  if (type === "deleted") return "diff-removed";
  if (type === "renamed") return "diff-renamed";
  return "diff-modified";
}

function severityIcon(severity: Finding["severity"]): string {
  if (severity === "high") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}
