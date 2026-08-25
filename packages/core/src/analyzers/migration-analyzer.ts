import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

export class MigrationAnalyzer implements Analyzer {
  readonly name = "migration";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    return context.changes.files
      .filter((change) => isMigrationPath(change.path))
      .map(toFinding);
  }
}

function isMigrationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";

  if (segments.includes("migrations")) return true;
  if (basename === "migration.sql" || basename === "schema.sql") return true;
  if (normalized.endsWith("prisma/schema.prisma")) return true;
  if (/(^|\/)db\/migration\/(v|r|u)\d.*__.+\.sql$/.test(normalized)) return true;
  return /(^|\/)[^/]*(database-)?changelog[^/]*\.(xml|ya?ml|json|sql)$/.test(normalized);
}

function toFinding(change: FileChange): Finding {
  const action = actionFor(change.type);
  return {
    severity: "high",
    category: "database",
    title: `Database migration ${action.title}`,
    description: `A migration-related file was ${action.description}. Review schema changes, destructive operations, data transformations, and rollback implications.`,
    files: [change.path],
    evidence: [`Change type: ${change.type}`],
  };
}

function actionFor(type: FileChange["type"]): { title: string; description: string } {
  switch (type) {
    case "created": return { title: "added", description: "added" };
    case "deleted": return { title: "deleted", description: "deleted" };
    case "renamed": return { title: "renamed", description: "renamed" };
    case "modified": return { title: "changed", description: "modified" };
  }
}
