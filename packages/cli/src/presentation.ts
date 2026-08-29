import type { FileChange, Finding, FindingSeverity, ReviewResult, RiskAssessment, Verdict } from "@agentcheck/core";

const RULE = "────────────────────────────";
const WIDE_RULE = "─────────────────────────────────────────";
const DEFAULT_REPORT_WIDTH = 80;
const MAX_REPORT_WIDTH = 100;
const MIN_REPORT_WIDTH = 12;
const VERDICT_MAX_WIDTH = 62;

export interface PresentationOptions {
  readonly interactive?: boolean;
  readonly color?: boolean;
  readonly durationMs?: number;
  readonly width?: number;
}

export function formatCheckpointCreated(branch: string | null, head: string, options: PresentationOptions = {}): string {
  if (!options.interactive) {
    return ["✓ Checkpoint created", "Branch: " + formatBranch(branch), "Commit: " + shortCommit(head)].join("\n");
  }

  return [
    formatHeader("Start", options),
    success("Repository inspected", options),
    success("Baseline captured" + formatDuration(options.durationMs), options),
    "",
    "Baseline ready.",
    "",
    "Run your coding agent, then:",
    "",
    "  " + command("agentcheck", options),
    "",
    secondary("Branch: " + formatBranch(branch) + "  •  Commit: " + shortCommit(head), options),
  ].join("\n");
}

export function formatReview(result: ReviewResult, options: PresentationOptions = {}): string {
  if (!options.interactive) return formatPlainReview(result, options);

  const sections = [
    formatHeader("Review", options),
    success("Baseline loaded", options),
    success("Changes inspected", options),
    success("Analysis complete" + formatDuration(options.durationMs), options),
  ];
  const context = formatContextChange(result, options);
  if (context) sections.push(context);

  if (result.changes.files.length === 0) {
    sections.push(success("No changes since checkpoint.", options));
    return sections.join("\n\n");
  }

  const counts = countChanges(result.changes.files);
  sections.push(formatChanges(result.changes.files, counts, options));
  sections.push(formatFindings(result.findings, options));
  sections.push(formatRisk(result.risk, options));
  sections.push(formatVerdict(result, options));
  sections.push(success("Review completed" + formatDuration(options.durationMs), options));
  return sections.join("\n\n");
}

function formatPlainReview(result: ReviewResult, options: PresentationOptions): string {
  const sections = ["AgentCheck"];
  const context = formatContextChange(result, options);
  if (context) sections.push(context);

  if (result.changes.files.length === 0) {
    sections.push("✓ No changes since checkpoint.");
    return sections.join("\n\n");
  }

  const counts = countChanges(result.changes.files);
  sections.push([
    "Changes",
    rule(options),
    counts.modified + " modified",
    counts.created + " created",
    counts.deleted + " deleted",
    counts.renamed + " renamed",
    "",
    ...result.changes.files.map((file) => formatFileChange(file, options)),
  ].join("\n"));
  sections.push(formatFindings(result.findings, options));
  sections.push(formatRisk(result.risk, options));
  sections.push(formatVerdict(result, options));
  return sections.join("\n\n");
}

function countChanges(files: readonly FileChange[]): Record<FileChange["type"], number> {
  const counts: Record<FileChange["type"], number> = { modified: 0, created: 0, deleted: 0, renamed: 0 };
  for (const file of files) counts[file.type] += 1;
  return counts;
}

function formatChanges(
  files: readonly FileChange[],
  counts: Record<FileChange["type"], number>,
  options: PresentationOptions,
): string {
  return [
    heading("Changes", options),
    formatChangeCounts(counts, options),
    "",
    ...files.map((file) => formatFileChange(file, options)),
  ].join("\n");
}

function formatRisk(risk: RiskAssessment, options: PresentationOptions = {}): string {
  const level = risk.level.toUpperCase();
  const explanation = risk.contributions.length === 0
    ? "No scored risk signals; changed-file counts are shown separately."
    : "Based on " + risk.contributions.length + " distinct " + (risk.contributions.length === 1 ? "risk signal" : "risk signals") + "; changed-file counts are shown separately.";

  return [
    options.interactive ? heading("Risk", options) : ["Risk", rule(options)].join("\n"),
    ...risk.contributions.map((contribution) => options.interactive
      ? bold("+" + contribution.points, options) + "  " + contribution.reason
      : "+" + contribution.points + " " + contribution.reason),
    ...(risk.contributions.length > 0 ? [""] : []),
    options.interactive
      ? bold("Score: " + risk.score, options) + " — " + severity(level, options)
      : "Score: " + risk.score + " — " + level,
    ...wrapText(explanation, options),
  ].join("\n");
}

function formatVerdict(result: ReviewResult, options: PresentationOptions = {}): string {
  const verdict = result.verdict;
  const summary = formatVerdictSummary(result.findings, result.risk);
  const topics = reviewTopics(result);

  if (options.interactive) {
    const marker = verdict === "LOOKS ROUTINE" ? "✓" : "⚠";
    const guidance = VERDICT_GUIDANCE[verdict];
    return [
      heading("Verdict", options),
      formatVerdictBox([
        marker + "  " + verdict,
        "",
        summary,
        "",
        guidance[0]!,
        ...(topics.length > 0
          ? ["", "Review before commit:", ...topics.map((topic) => "→ " + topic)]
          : ["", guidance[1]!]),
      ], verdict, options),
    ].join("\n");
  }

  const guidance = VERDICT_GUIDANCE[verdict];
  return [
    "Verdict",
    rule(options),
    verdict,
    summary,
    ...wrapText(guidance[0]!, options),
    ...(topics.length > 0
      ? ["Review before commit:", ...topics.map((topic) => "→ " + topic)]
      : wrapText(guidance[1]!, options)),
  ].join("\n");
}

const VERDICT_GUIDANCE: Record<Verdict, readonly string[]> = {
  "LOOKS ROUTINE": ["No high-risk patterns were detected.", "Review the diff normally before committing."],
  "REVIEW RECOMMENDED": ["AgentCheck found changes that deserve closer inspection before commit.", "Review the highlighted findings and affected files."],
  "CAREFUL REVIEW RECOMMENDED": ["One or more high-severity findings require careful inspection before commit.", "Review the highlighted findings and affected files."],
};

function formatFindings(findings: readonly Finding[], options: PresentationOptions = {}): string {
  if (findings.length === 0) {
    return [
      options.interactive ? heading("Findings", options) : ["Findings", rule(options)].join("\n"),
      success("No deterministic review findings.", options),
    ].join("\n");
  }

  return [
    options.interactive ? heading("Findings", options) : ["Findings", rule(options)].join("\n"),
    formatFindingsSummary(findings),
    "",
    findings.map((finding) => formatFinding(finding, options)).join("\n\n"),
  ].join("\n");
}

function formatFindingsSummary(findings: readonly Finding[]): string {
  const summary = severitySummaryParts(findings, true);
  return findings.length + " " + (findings.length === 1 ? "finding" : "findings") + " · " + summary.join(" · ");
}

function formatFinding(finding: Finding, options: PresentationOptions): string {
  const label = finding.severity.toUpperCase();
  const marker = label === "HIGH" ? "▲" : "◆";
  const details = [
    severity(marker + "  " + label, options) + "  " + bold(finding.title, options),
    ...finding.files.map((file) => "  " + path(file, options)),
    "",
    ...wrapText(finding.description, options, 2),
  ];

  if (finding.evidence?.length) {
    details.push("", "  " + subtle("Evidence:", options));
    for (const evidence of finding.evidence) details.push(...wrapBullet(evidence, options));
  }

  return details.join("\n");
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
    "  agentcheck check --format json    Emit the review report as JSON",
    "",
    "Options:",
    "  -h, --help",
    "  -v, --version",
  ].join("\n");
}

function formatContextChange(result: ReviewResult, options: PresentationOptions = {}): string | null {
  if (!result.branchChanged && !result.headChanged) return null;
  const lines = [
    options.interactive ? heading("Repository context changed since checkpoint.", options) : "Repository context changed since checkpoint.",
  ];
  if (result.branchChanged) {
    lines.push("", "Branch:", "  " + formatBranch(result.checkpoint.branch) + " → " + formatBranch(result.current.branch));
  }
  if (result.headChanged) {
    lines.push("", "Commit:", "  " + shortCommit(result.checkpoint.head) + " → " + shortCommit(result.current.head));
  }
  return lines.join("\n");
}

function formatFileChange(file: FileChange, options: PresentationOptions = {}): string {
  switch (file.type) {
    case "modified":
      return changeStatus("M", "modified", options) + "  " + path(file.path, options);
    case "created":
      return changeStatus("A", "created", options) + "  " + path(file.path, options);
    case "deleted":
      return changeStatus("D", "deleted", options) + "  " + path(file.path, options);
    case "renamed":
      return changeStatus("R", "renamed", options) + "  " + path(file.previousPath ?? "(unknown)", options) + " → " + path(file.path, options);
  }
}

function changeStatus(
  letter: string,
  type: FileChange["type"],
  options: PresentationOptions,
): string {
  const code = type === "created" ? "32" : type === "deleted" ? "91" : type === "modified" ? "33" : "36";
  return style(letter, options, "1", code);
}

function formatHeader(commandName: string, options: PresentationOptions): string {
  return [
    "  " + identity("AGENTCHECK", options),
    "  " + secondary("Verify what your coding agent changed.", options),
    "",
    "  " + identity("◈ " + commandName, options),
    "  " + subtle(wideRule(options), options),
  ].join("\n");
}

function heading(value: string, options: PresentationOptions): string {
  if (!options.interactive) return value;
  return identity(value.toUpperCase(), options) + "\n" + subtle(wideRule(options), options);
}

function formatVerdictBox(lines: readonly string[], verdict: Verdict, options: PresentationOptions): string {
  const width = Math.min(VERDICT_MAX_WIDTH, reportWidth(options));
  const content = lines.flatMap((line, index) => {
    if (!line) return [""];
    return index === 0 && line.length <= width - 4 ? [line] : wrap(line, Math.max(1, width - 4));
  });
  const border = subtle("╭" + "─".repeat(Math.max(0, width - 2)) + "╮", options);
  const bottom = subtle("╰" + "─".repeat(Math.max(0, width - 2)) + "╯", options);
  const rendered = content.map((line, index) => {
    const styled = index === 0 ? verdictStyle(line, verdict, options) : line;
    return subtle("│", options) + "  " + styled + " ".repeat(Math.max(0, width - 4 - line.length)) + subtle("│", options);
  });
  return [border, ...rendered, bottom].join("\n");
}

function formatChangeCounts(counts: Record<FileChange["type"], number>, options: PresentationOptions): string {
  const separator = subtle(" • ", options);
  return [
    bold(String(counts.modified), options) + " modified",
    bold(String(counts.created), options) + " created",
    bold(String(counts.deleted), options) + " deleted",
    bold(String(counts.renamed), options) + " renamed",
  ].join(separator);
}

function formatDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? "" : " in " + durationMs + "ms";
}

function formatVerdictSummary(findings: readonly Finding[], risk: RiskAssessment): string {
  const severityParts = severitySummaryParts(findings, true);
  return [...(severityParts.length > 0 ? severityParts : ["No findings"]), "Risk " + risk.level.toUpperCase() + " (" + risk.score + ")"].join(" · ");
}

function severitySummaryParts(findings: readonly Finding[], pluralize: boolean): string[] {
  const counts = new Map<FindingSeverity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);

  const order: readonly FindingSeverity[] = ["high", "warning", "info"];
  return order.flatMap((severity) => {
    const count = counts.get(severity);
    if (!count) return [];
    const label = severity.toUpperCase() + (pluralize && count !== 1 ? "S" : "");
    return [count + " " + label];
  });
}

function reviewTopics(result: ReviewResult): string[] {
  const topics = new Map<string, string>();
  for (const contribution of result.risk.contributions) {
    const key = riskTopicKey(contribution.id);
    topics.set(key, topicLabel(key));
  }
  for (const finding of result.findings) {
    if (!topics.has(finding.category)) topics.set(finding.category, categoryLabel(finding.category));
  }
  return [...topics.values()].slice(0, 3);
}

function riskTopicKey(id: string | undefined): string {
  if (id?.startsWith("database.")) return "database";
  if (id?.startsWith("security.")) return "secret";
  if (id?.startsWith("configuration.")) return "configuration";
  if (id?.startsWith("dependency.")) return "dependency";
  if (id?.startsWith("delivery.")) return "dangerous-file";
  if (id?.startsWith("testing.")) return "test-attention";
  if (id === "review.file-deleted") return "deleted-file";
  if (id?.startsWith("review.")) return "large-change";
  return `risk:${id ?? "unknown"}`;
}

function topicLabel(key: string): string {
  switch (key) {
    case "database": return categoryLabel("database");
    case "secret": return categoryLabel("secret");
    case "configuration": return categoryLabel("configuration");
    case "dependency": return categoryLabel("dependency");
    case "dangerous-file": return categoryLabel("dangerous-file");
    case "test-attention": return categoryLabel("test-attention");
    case "large-change": return categoryLabel("large-change");
    case "deleted-file": return "Deleted file";
    default: return "Other review signals";
  }
}
function categoryLabel(category: Finding["category"]): string {
  switch (category) {
    case "database": return "Database migrations";
    case "configuration": return "Configuration changes";
    case "dependency": return "Dependency changes";
    case "dangerous-file": return "Repository or CI controls";
    case "large-change": return "Large changes";
    case "secret": return "Possible secrets";
    case "test-attention": return "Tests may need review";
    case "semantic-risk": return "Semantic risk changes";
    case "sensitive-file": return "Sensitive files";
  }
}

function wrapText(value: string, options: PresentationOptions, indent = 0): string[] {
  const prefix = " ".repeat(indent);
  return wrap(value, Math.max(1, reportWidth(options) - indent)).map((line) => prefix + line);
}

function wrapBullet(value: string, options: PresentationOptions): string[] {
  const prefix = "    - ";
  const continuation = " ".repeat(prefix.length);
  return wrap(value, Math.max(1, reportWidth(options) - prefix.length)).map((line, index) => (index === 0 ? prefix : continuation) + line);
}

function wrap(value: string, width: number): string[] {
  return value.split(/\r?\n/).flatMap((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [""];

    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (line && candidate.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  });
}

function reportWidth(options: PresentationOptions): number {
  if (typeof options.width !== "number" || !Number.isFinite(options.width)) return DEFAULT_REPORT_WIDTH;
  return Math.max(MIN_REPORT_WIDTH, Math.min(MAX_REPORT_WIDTH, Math.floor(options.width)));
}

function rule(options: PresentationOptions): string {
  return "─".repeat(Math.min(RULE.length, reportWidth(options)));
}

function wideRule(options: PresentationOptions): string {
  return "─".repeat(Math.min(WIDE_RULE.length, Math.max(1, reportWidth(options) - 2)));
}

function identity(value: string, options: PresentationOptions): string {
  return style(value, options, "1", "96");
}

function success(value: string, options: PresentationOptions): string {
  return style("✓", options, "32") + " " + style(value, options, "32");
}

function severity(value: string, options: PresentationOptions): string {
  if (value.includes("HIGH")) return style(value, options, "1", "91");
  if (value.includes("WARNING") || value.includes("MEDIUM") || value.includes("REVIEW")) return style(value, options, "1", "33");
  return style(value, options, "1", "32");
}

function verdictStyle(value: string, verdict: Verdict, options: PresentationOptions): string {
  return verdict === "LOOKS ROUTINE" ? style(value, options, "1", "32") : severity(value, options);
}

function command(value: string, options: PresentationOptions): string {
  return style(value, options, "1", "36");
}

function path(value: string, options: PresentationOptions): string {
  return style(value, options, "1", "97");
}

function bold(value: string, options: PresentationOptions): string {
  return style(value, options, "1");
}

function secondary(value: string, options: PresentationOptions): string {
  return style(value, options, "90");
}

function subtle(value: string, options: PresentationOptions): string {
  return style(value, options, "2");
}

function style(value: string, options: PresentationOptions, ...codes: readonly string[]): string {
  return options.color ? "\u001B[" + codes.join(";") + "m" + value + "\u001B[0m" : value;
}

function formatBranch(branch: string | null): string {
  return branch ?? "detached HEAD";
}

function shortCommit(head: string): string {
  return head.slice(0, 7);
}
