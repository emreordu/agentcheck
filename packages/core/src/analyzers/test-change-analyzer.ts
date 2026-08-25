import { compareLines, decodeText } from "../line-diff.ts";
import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

export const TEST_ATTENTION_THRESHOLDS = {
  changedLinesPerFile: 20,
  productionFiles: 3,
} as const;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
  ".kt", ".kts", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
]);

interface ProductionChange {
  change: FileChange;
  changedLines: number;
}

export class TestChangeAnalyzer implements Analyzer {
  readonly name = "test-change";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    const testPaths = context.changes.files.flatMap(testPathCandidates);
    const productionChanges: ProductionChange[] = [];

    for (const change of context.changes.files) {
      if (!isProductionSourcePath(change.path)) continue;
      const beforePath = change.type === "renamed" ? change.previousPath ?? change.path : change.path;
      const [beforeContent, afterContent] = await Promise.all([
        context.files.readBefore(beforePath),
        context.files.readAfter(change.path),
      ]);
      const before = beforeContent === null ? "" : decodeText(beforeContent);
      const after = afterContent === null ? "" : decodeText(afterContent);
      if (before === null || after === null) continue;

      const lineChanges = compareLines(before, after);
      const changedLines = lineChanges.added + lineChanges.removed;
      if (changedLines > 0) productionChanges.push({ change, changedLines });
    }

    const manyProductionFiles = productionChanges.length >= TEST_ATTENTION_THRESHOLDS.productionFiles;
    const withoutRelatedTests = productionChanges
      .filter(({ change }) => relatedTests(change.path, testPaths).length === 0);
    const findings = withoutRelatedTests
      .filter(({ changedLines }) => changedLines >= TEST_ATTENTION_THRESHOLDS.changedLinesPerFile)
      .map(({ change, changedLines }) => toFileFinding(change, changedLines, productionChanges.length));

    if (manyProductionFiles) {
      const breadthOnly = withoutRelatedTests
        .filter(({ changedLines }) => changedLines < TEST_ATTENTION_THRESHOLDS.changedLinesPerFile);
      if (breadthOnly.length > 0) findings.push(toBreadthFinding(breadthOnly, productionChanges.length));
    }

    return findings;
  }
}

export function isTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  const lowerBasename = basename.toLowerCase();
  const directories = normalized.split("/").slice(0, -1);

  if (directories.some((segment) =>
    segment === "test" || segment === "tests" || segment === "__tests__" || /Tests?$/.test(segment))) return true;
  if (/\.(test|spec)\.[^.]+$/i.test(basename)) return true;
  if (/^(test_.+|.+_test)\.py$/i.test(basename)) return true;
  if (/_test\.go$/i.test(basename)) return true;
  if (/Tests?\.cs$/i.test(basename) || /\.Tests\.csproj$/i.test(basename)) return true;
  return lower.includes("/__tests__/") || lowerBasename === "test.js";
}

function isProductionSourcePath(path: string): boolean {
  if (isTestPath(path) || isMigrationPath(path) || isGeneratedPath(path)) return false;
  const lower = path.replaceAll("\\", "/").toLowerCase();
  if (lower.endsWith(".d.ts")) return false;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(lower.slice(dot));
}

function isMigrationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return normalized.split("/").includes("migrations")
    || normalized.endsWith("migration.sql")
    || normalized.endsWith("schema.sql")
    || normalized.endsWith("prisma/schema.prisma")
    || normalized.includes("/db/migration/");
}

function isGeneratedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(dist|build|generated|vendor|node_modules)(\/|$)/.test(normalized)
    || /\.(g|generated|designer)\.[^.]+$/.test(normalized);
}

function testPathCandidates(change: FileChange): string[] {
  const candidates = [change.path, ...(change.previousPath ? [change.previousPath] : [])];
  return candidates.filter(isTestPath);
}

function relatedTests(productionPath: string, testPaths: readonly string[]): string[] {
  const productionName = normalizedSubjectName(productionPath);
  return testPaths.filter((testPath) => normalizedSubjectName(testPath) === productionName);
}

function normalizedSubjectName(path: string): string {
  let basename = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  basename = basename.replace(/\.[^.]+$/, "");
  basename = basename.replace(/\.(test|spec)$/i, "");
  basename = basename.replace(/^test[_-]/i, "").replace(/[_-]test$/i, "");
  basename = basename.replace(/Tests?$/i, "");
  return basename.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toFileFinding(change: FileChange, changedLines: number, productionFiles: number): Finding {
  return {
    severity: "warning",
    category: "test-attention",
    title: "Tests may need review",
    description: "A substantial production-source change has no related changed test file. Verify that the changed behavior remains covered and existing assertions were not weakened or removed unintentionally.",
    files: [change.path],
    evidence: [
      `Production lines changed: ${changedLines}`,
      `Production source files changed: ${productionFiles}`,
      "Related test files changed: 0",
    ],
  };
}

function toBreadthFinding(changes: readonly ProductionChange[], productionFiles: number): Finding {
  return {
    severity: "warning",
    category: "test-attention",
    title: "Tests may need review",
    description: `${productionFiles} production source files changed without related changed test files for the listed paths. Verify that the changed behavior remains covered and existing assertions were not weakened or removed unintentionally.`,
    files: changes.map(({ change }) => change.path).sort((left, right) => left.localeCompare(right, "en")),
    evidence: [
      `Production source files changed: ${productionFiles}`,
      "Related test files changed: 0",
    ],
  };
}
