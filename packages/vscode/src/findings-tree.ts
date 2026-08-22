import type {
  FileChange,
  Finding,
  FindingSeverity,
  ReviewResult,
  RiskLevel,
} from "@agentcheck/core";

export type ReviewPresentation = Pick<ReviewResult, "changes" | "findings" | "risk" | "verdict">;

export type FindingTreeNode =
  | SectionNode
  | ChangeNode
  | SeverityNode
  | FindingNode
  | FileNode
  | DetailNode
  | EvidenceGroupNode
  | EvidenceNode
  | RiskValueNode
  | VerdictValueNode;

export interface SectionNode {
  kind: "section";
  section: "changes" | "findings" | "risk" | "verdict";
  result: ReviewPresentation;
}

export interface ChangeNode {
  kind: "change";
  change: FileChange;
}

export interface SeverityNode {
  kind: "severity";
  severity: FindingSeverity;
  findings: Finding[];
}

export interface FindingNode {
  kind: "finding";
  finding: Finding;
}

export interface FileNode {
  kind: "file";
  path: string;
}

export interface DetailNode {
  kind: "detail";
  label: "Why it matters";
  value: string;
}

export interface EvidenceGroupNode {
  kind: "evidence-group";
  evidence: string[];
}

export interface EvidenceNode {
  kind: "evidence";
  value: string;
}

export interface RiskValueNode {
  kind: "risk-value";
  label: "Score" | "Level";
  value: string;
}

export interface VerdictValueNode {
  kind: "verdict-value";
  value: ReviewResult["verdict"];
}

const SEVERITIES: readonly FindingSeverity[] = ["high", "warning", "info"];

export function buildReviewTree(result: ReviewPresentation): SectionNode[] {
  return [
    { kind: "section", section: "changes", result },
    { kind: "section", section: "findings", result },
    { kind: "section", section: "risk", result },
    { kind: "section", section: "verdict", result },
  ];
}

export function childrenOf(node: FindingTreeNode): FindingTreeNode[] {
  switch (node.kind) {
    case "section": return sectionChildren(node);
    case "severity": return node.findings.map((finding) => ({ kind: "finding", finding }));
    case "finding": return findingChildren(node.finding);
    case "evidence-group": return node.evidence.map((value) => ({ kind: "evidence", value }));
    case "change":
    case "file":
    case "detail":
    case "evidence":
    case "risk-value":
    case "verdict-value": return [];
  }
}

export function changeLabel(change: FileChange): string {
  switch (change.type) {
    case "modified": return `M ${change.path}`;
    case "created": return `A ${change.path}`;
    case "deleted": return `D ${change.path}`;
    case "renamed": return `R ${change.previousPath ?? change.path} -> ${change.path}`;
  }
}

export function checkpointStatus(): { text: string; tooltip: string } {
  return {
    text: "$(shield) AgentCheck: CHECKPOINT",
    tooltip: "An AgentCheck checkpoint is active. Run AgentCheck: Review Changes.",
  };
}

export function reviewStatus(level: RiskLevel): { text: string; tooltip: string } {
  return {
    text: `$(shield) AgentCheck: ${level.toUpperCase()}`,
    tooltip: "Show the latest AgentCheck review",
  };
}

function sectionChildren(node: SectionNode): FindingTreeNode[] {
  switch (node.section) {
    case "changes":
      return node.result.changes.files.map((change) => ({ kind: "change", change }));
    case "findings":
      return SEVERITIES.flatMap((severity) => {
        const findings = node.result.findings.filter((finding) => finding.severity === severity);
        return findings.length === 0 ? [] : [{ kind: "severity" as const, severity, findings }];
      });
    case "risk":
      return [
        { kind: "risk-value", label: "Score", value: String(node.result.risk.score) },
        { kind: "risk-value", label: "Level", value: node.result.risk.level.toUpperCase() },
      ];
    case "verdict":
      return [{ kind: "verdict-value", value: node.result.verdict }];
  }
}

function findingChildren(finding: Finding): FindingTreeNode[] {
  const children: FindingTreeNode[] = finding.files.map((path) => ({ kind: "file", path }));
  children.push({ kind: "detail", label: "Why it matters", value: finding.description });
  if (finding.evidence?.length) {
    children.push({ kind: "evidence-group", evidence: finding.evidence });
  }
  return children;
}
