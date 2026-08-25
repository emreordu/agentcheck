import type { FileChange, Finding, ReviewResult, RiskAssessment, Verdict } from "@agentcheck/core";

const RULE = "────────────────────────────";

export function formatCheckpointCreated(branch: string | null, head: string): string {
  return [
    "✓ Checkpoint created",
    `Branch: ${formatBranch(branch)}`,
    `Commit: ${shortCommit(head)}`,
  ].join("\n");
}

export function formatReview(result: ReviewResult): string {
  const sections = ["AgentCheck"];

  const context = formatContextChange(result);
  if (context) sections.push(context);

  if (result.changes.files.length === 0) {
    sections.push("✓ No changes since checkpoint.");
    return sections.join("\n\n");
  }

  const counts = {
    modified: 0,
    created: 0,
    deleted: 0,
    renamed: 0,
  };

  for (const file of result.changes.files) {
    counts[file.type] += 1;
  }

  sections.push([
    "Changes",
    RULE,
    `${counts.modified} modified`,
    `${counts.created} created`,
    `${counts.deleted} deleted`,
    `${counts.renamed} renamed`,
    "",
    ...result.changes.files.map(formatFileChange),
  ].join("\n"));
  sections.push(formatFindings(result.findings));
  sections.push(formatRisk(result.risk));
  sections.push(formatVerdict(result.verdict));

  return sections.join("\n\n");
}

function formatRisk(risk: RiskAssessment): string {
  return [
    "Risk",
    RULE,
    ...risk.contributions.map((contribution) => `+${contribution.points} ${contribution.reason}`),
    ...(risk.contributions.length > 0 ? [""] : []),
    `Score: ${risk.score} — ${risk.level.toUpperCase()}`,
    risk.contributions.length === 0
      ? "No scored risk signals; changed-file counts are shown separately."
      : `Based on ${risk.contributions.length} distinct ${risk.contributions.length === 1 ? "risk signal" : "risk signals"}; changed-file counts are shown separately.`,
  ].join("\n");
}

function formatVerdict(verdict: Verdict): string {
  return [
    "Verdict",
    RULE,
    verdict,
    ...VERDICT_GUIDANCE[verdict],
  ].join("\n");
}

const VERDICT_GUIDANCE: Record<Verdict, readonly string[]> = {
  "LOOKS ROUTINE": [
    "No high-risk patterns were detected.",
    "Review the diff normally before committing.",
  ],
  "REVIEW RECOMMENDED": [
    "AgentCheck found changes that deserve closer inspection before commit.",
    "Review the highlighted findings and affected files.",
  ],
  "CAREFUL REVIEW RECOMMENDED": [
    "One or more high-severity findings require careful inspection before commit.",
    "Review the highlighted findings and affected files.",
  ],
};

function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return [
      "Findings",
      RULE,
      "✓ No deterministic review findings.",
    ].join("\n");
  }

  const entries = findings.map((finding) => [
    finding.severity.toUpperCase(),
    finding.title,
    finding.description,
    ...finding.files,
    ...(finding.evidence?.length
      ? ["Evidence:", ...finding.evidence.map((item) => `  - ${item}`)]
      : []),
  ].join("\n"));

  return [
    "Findings",
    RULE,
    "",
    entries.join("\n\n"),
    "",
    `${findings.length} ${findings.length === 1 ? "finding" : "findings"} reported.`,
  ].join("\n");
}

export function formatHelp(): string {
  return [
    "AgentCheck",
    "",
    "Independent change verification for AI-assisted coding.",
    "",
    "Usage:",
    "  agentcheck start    Create a checkpoint",
    "  agentcheck          Review changes since checkpoint",
    "  agentcheck check    Review changes since checkpoint",
    "  agentcheck clear    Clear the active checkpoint",
    "",
    "Options:",
    "  -h, --help",
    "  -v, --version",
  ].join("\n");
}

function formatContextChange(result: ReviewResult): string | null {
  if (!result.branchChanged && !result.headChanged) return null;

  const lines = ["Repository context changed since checkpoint."];

  if (result.branchChanged) {
    lines.push(
      "",
      "Branch:",
      `  ${formatBranch(result.checkpoint.branch)} → ${formatBranch(result.current.branch)}`,
    );
  }

  if (result.headChanged) {
    lines.push(
      "",
      "Commit:",
      `  ${shortCommit(result.checkpoint.head)} → ${shortCommit(result.current.head)}`,
    );
  }

  return lines.join("\n");
}

function formatFileChange(file: FileChange): string {
  switch (file.type) {
    case "modified":
      return `M  ${file.path}`;
    case "created":
      return `A  ${file.path}`;
    case "deleted":
      return `D  ${file.path}`;
    case "renamed":
      return `R  ${file.previousPath ?? "(unknown)"} → ${file.path}`;
  }
}

function formatBranch(branch: string | null): string {
  return branch ?? "detached HEAD";
}

function shortCommit(head: string): string {
  return head.slice(0, 7);
}
