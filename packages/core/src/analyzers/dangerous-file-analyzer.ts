import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

export class DangerousFileAnalyzer implements Analyzer {
  readonly name = "dangerous-file";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    return context.changes.files
      .filter((change) => classify(change.path) !== null)
      .map(toFinding);
  }
}

type DangerousKind = "gitignore" | "gitattributes" | "ci";

function classify(path: string): DangerousKind | null {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";

  if (basename === ".gitignore") return "gitignore";
  if (basename === ".gitattributes") return "gitattributes";
  if (normalized.startsWith(".github/") || normalized.includes("/.github/")) return "ci";
  if (basename === "jenkinsfile" || basename === "azure-pipelines.yml" || basename === ".gitlab-ci.yml") return "ci";
  return null;
}

function toFinding(change: FileChange): Finding {
  const kind = classify(change.path);
  if (kind === null) throw new Error(`Unexpected dangerous-file classification for ${change.path}.`);

  const deleted = change.type === "deleted";
  const title = titleFor(kind, deleted);
  return {
    severity: deleted ? "high" : "warning",
    category: "dangerous-file",
    title,
    description: descriptionFor(kind, change),
    files: [change.path],
    evidence: [`Change type: ${change.type}`],
  };
}

function titleFor(kind: DangerousKind, deleted: boolean): string {
  if (deleted) return kind === "ci" ? "CI/CD file deleted" : "Repository control file deleted";
  if (kind === "gitignore") return "Git ignore rules changed";
  if (kind === "gitattributes") return "Git attributes changed";
  return "CI/CD configuration changed";
}

function descriptionFor(kind: DangerousKind, change: FileChange): string {
  if (kind === "gitignore") {
    return `Repository ignore rules were ${describeChange(change.type)} and may change which files Git reports. Review the affected patterns and expected generated or local files.`;
  }
  if (kind === "gitattributes") {
    return `Git attribute rules were ${describeChange(change.type)} and may change path handling. Review line endings, merge behavior, and binary-file rules.`;
  }
  return `Automation configuration was ${describeChange(change.type)} and may change build, test, or delivery behavior. Review triggers, permissions, and referenced settings.`;
}

function describeChange(type: FileChange["type"]): string {
  switch (type) {
    case "created": return "added";
    case "modified": return "modified";
    case "deleted": return "deleted";
    case "renamed": return "renamed";
  }
}
