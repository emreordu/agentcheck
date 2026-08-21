import type { Finding, FindingSeverity } from "@agentcheck/core";

export type FindingTreeNode = SeverityNode | FindingNode | FileNode;

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

const SEVERITIES: readonly FindingSeverity[] = ["high", "warning", "info"];

export function buildFindingTree(findings: readonly Finding[]): SeverityNode[] {
  return SEVERITIES.flatMap((severity) => {
    const matching = findings.filter((finding) => finding.severity === severity);
    return matching.length === 0 ? [] : [{ kind: "severity", severity, findings: matching }];
  });
}

export function childrenOf(node: FindingTreeNode): FindingTreeNode[] {
  switch (node.kind) {
    case "severity": return node.findings.map((finding) => ({ kind: "finding", finding }));
    case "finding": return node.finding.files.map((path) => ({ kind: "file", path }));
    case "file": return [];
  }
}
