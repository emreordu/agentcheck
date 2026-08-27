import { ConfigurationAnalyzer } from "./analyzers/configuration-analyzer.ts";
import { DangerousFileAnalyzer } from "./analyzers/dangerous-file-analyzer.ts";
import { DependencyAnalyzer } from "./analyzers/dependency-analyzer.ts";
import { LargeChangeAnalyzer } from "./analyzers/large-change-analyzer.ts";
import { MigrationAnalyzer } from "./analyzers/migration-analyzer.ts";
import { SecretAnalyzer } from "./analyzers/secret-analyzer.ts";
import { SemanticRiskAnalyzer } from "./analyzers/semantic-risk-analyzer.ts";
import { TestChangeAnalyzer } from "./analyzers/test-change-analyzer.ts";
import type { AnalysisContext, Analyzer, FileContentProvider, Finding, FindingSeverity } from "./types.ts";

export const defaultAnalyzers: readonly Analyzer[] = [
  new MigrationAnalyzer(),
  new ConfigurationAnalyzer(),
  new DangerousFileAnalyzer(),
  new DependencyAnalyzer(),
  new SecretAnalyzer(),
  new SemanticRiskAnalyzer(),
  new TestChangeAnalyzer(),
  new LargeChangeAnalyzer(),
];

export async function analyzeChanges(
  context: AnalysisContext,
  analyzers: readonly Analyzer[] = defaultAnalyzers,
): Promise<Finding[]> {
  const cachedContext: AnalysisContext = {
    ...context,
    files: createCachedFileContentProvider(context.files),
  };
  const findings: Finding[] = [];

  for (const analyzer of analyzers) {
    findings.push(...await analyzer.analyze(cachedContext));
  }

  return findings.sort(compareFindings);
}

export function createCachedFileContentProvider(provider: FileContentProvider): FileContentProvider {
  const before = new Map<string, Promise<Buffer | null>>();
  const after = new Map<string, Promise<Buffer | null>>();

  return {
    readBefore: (path) => cachedRead(before, path, provider.readBefore),
    readAfter: (path) => cachedRead(after, path, provider.readAfter),
  };
}

function cachedRead(
  cache: Map<string, Promise<Buffer | null>>,
  path: string,
  read: (path: string) => Promise<Buffer | null>,
): Promise<Buffer | null> {
  const existing = cache.get(path);
  if (existing) return existing;

  const value = read(path);
  cache.set(path, value);
  return value;
}

function compareFindings(left: Finding, right: Finding): number {
  return severityRank(left.severity) - severityRank(right.severity)
    || left.category.localeCompare(right.category, "en")
    || left.title.localeCompare(right.title, "en")
    || (left.files[0] ?? "").localeCompare(right.files[0] ?? "", "en")
    || left.description.localeCompare(right.description, "en");
}

function severityRank(severity: FindingSeverity): number {
  switch (severity) {
    case "high": return 0;
    case "warning": return 1;
    case "info": return 2;
  }
}
