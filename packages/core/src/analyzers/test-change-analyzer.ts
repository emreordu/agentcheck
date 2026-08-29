import { compareLines, decodeText } from "../line-diff.ts";
import { FINDING_IDS } from "../stable-ids.ts";
import { actionForFinding } from "../finding-actions.ts";
import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

export const TEST_ATTENTION_THRESHOLDS = {
  changedLinesPerFile: 20,
  productionFiles: 3,
} as const;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
  ".kt", ".kts", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
]);

const ANONYMOUS_ACCESS = /\[\s*AllowAnonymous\s*\]/i;
const BOOTSTRAP_BASENAME = /^(?:program|startup|main|server|app|index)\.(?:cs|go|py|js|jsx|ts|tsx|dart)$/i;
const EXECUTABLE_RUNTIME_WIRING = /(?:\b(?:app|router|server)\s*\.|\b(?:use|listen|run|start|map|get|post|put|delete)\s*\()/i;

interface ProductionChange {
  change: FileChange;
  changedLines: number;
  after: string;
  introduced: readonly string[];
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
      if (changedLines > 0) productionChanges.push({
        change,
        changedLines,
        after,
        introduced: lineChanges.introduced,
      });
    }

    const manyProductionFiles = productionChanges.length >= TEST_ATTENTION_THRESHOLDS.productionFiles;
    const withoutRelatedTests = productionChanges
      .filter(({ change }) => relatedTests(change.path, testPaths).length === 0);
    const semanticGap = semanticTestReviewGap(productionChanges, testPaths);
    if (semanticGap !== null) return [toSemanticFinding(semanticGap)];

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

function semanticTestReviewGap(productionChanges: readonly ProductionChange[], testPaths: readonly string[]): ProductionChange[] | null {
  const newPublicSurface = productionChanges.find(({ change, after }) =>
    change.type === "created" && ANONYMOUS_ACCESS.test(after) && relatedTests(change.path, testPaths).length === 0);
  const bootstrapWiring = productionChanges.find(({ change, introduced }) =>
    isBootstrapPath(change.path)
      && introduced.some((line) => !isComment(line) && EXECUTABLE_RUNTIME_WIRING.test(line))
      && relatedTests(change.path, testPaths).length === 0);

  if (!newPublicSurface || !bootstrapWiring) return null;
  return [...new Map([newPublicSurface, bootstrapWiring].map((change) => [change.change.path, change])).values()];
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

function isBootstrapPath(path: string): boolean {
  const basename = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return BOOTSTRAP_BASENAME.test(basename);
}

function isComment(line: string): boolean {
  return /^\s*(?:\/\/|#|\/\*|\*)/.test(line);
}

function testPathCandidates(change: FileChange): string[] {
  const candidates = [change.path, ...(change.previousPath ? [change.previousPath] : [])];
  return candidates.filter(isTestPath);
}

function relatedTests(productionPath: string, testPaths: readonly string[]): string[] {
  const productionName = normalizedSubjectName(productionPath);
  return testPaths.filter((testPath) =>
    normalizedSubjectName(testPath) === productionName || isSharedSuiteFor(productionPath, testPath));
}

function isSharedSuiteFor(productionPath: string, testPath: string): boolean {
  const production = productionPath.replaceAll("\\", "/");
  const test = testPath.replaceAll("\\", "/");
  const productionDirectory = production.split("/").slice(0, -1).join("/");
  const testDirectory = test.split("/").slice(0, -1).join("/");
  const suite = normalizedSubjectName(test);
  return (suite === "analyzer" && productionDirectory === `${testDirectory}/analyzers`)
    || (suite === "cli" && productionDirectory === testDirectory);
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
    id: FINDING_IDS.testsNeedReview,
    severity: "warning",
    category: "test-attention",
    title: "Tests may need review",
    action: actionForFinding(FINDING_IDS.testsNeedReview),
    description: "A substantial production-source change has no related changed test file. Verify that the changed behavior remains covered and existing assertions were not weakened or removed unintentionally.",
    files: [change.path],
    evidence: [
      `Production lines changed: ${changedLines}`,
      `Production source files changed: ${productionFiles}`,
      "Related test files changed: 0",
    ],
  };
}

function toSemanticFinding(changes: readonly ProductionChange[]): Finding {
  return {
    id: FINDING_IDS.testsNeedReview,
    severity: "warning",
    category: "test-attention",
    title: "Tests may need review",
    action: actionForFinding(FINDING_IDS.testsNeedReview),
    description: "A new public production surface and application bootstrap wiring changed without related changed tests. Verify that the changed behavior remains covered and existing assertions were not weakened or removed unintentionally.",
    files: changes.map(({ change }) => change.path).sort((left, right) => left.localeCompare(right, "en")),
    evidence: [
      "New public production surface changed",
      "Application bootstrap runtime wiring changed",
      "Related test files changed: 0",
    ],
  };
}

function toBreadthFinding(changes: readonly ProductionChange[], productionFiles: number): Finding {
  return {
    id: FINDING_IDS.testsNeedReview,
    severity: "warning",
    category: "test-attention",
    title: "Tests may need review",
    action: actionForFinding(FINDING_IDS.testsNeedReview),
    description: `${productionFiles} production source files changed without related changed test files for the listed paths. Verify that the changed behavior remains covered and existing assertions were not weakened or removed unintentionally.`,
    files: changes.map(({ change }) => change.path).sort((left, right) => left.localeCompare(right, "en")),
    evidence: [
      `Production source files changed: ${productionFiles}`,
      "Related test files changed: 0",
    ],
  };
}
