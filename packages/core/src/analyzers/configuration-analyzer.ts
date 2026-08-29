import { FINDING_IDS } from "../stable-ids.ts";
import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

const EXACT_BASENAMES = new Set([
  ".env",
  "application.yml",
  "application.yaml",
  "application.properties",
  "config.yaml",
  "config.yml",
  "settings.py",
  "androidmanifest.xml",
  "network_security_config.xml",
  "info.plist",
  "pubspec.yaml",
  "gradle.properties",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "nginx.conf",
]);

export class ConfigurationAnalyzer implements Analyzer {
  readonly name = "configuration";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    return context.changes.files
      .filter((change) => isConfigurationPath(change.path))
      .map(toFinding);
  }
}

function isConfigurationPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";

  if (EXACT_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  if (/^appsettings.*\.json$/.test(basename)) return true;
  if (/^environment(?:\.[a-z0-9_-]+)?\.tsx?$/.test(basename)) return true;
  if (/^(?:next|vite)\.config\.(?:js|ts|mjs|cjs)$/.test(basename)) return true;
  if (basename.endsWith(".entitlements")) return true;
  if (basename.endsWith(".tf")) return true;
  return normalized.startsWith("terraform/") || normalized.includes("/terraform/");
}

function toFinding(change: FileChange): Finding {
  const production = isProductionPath(change.path);
  const deleted = change.type === "deleted";
  const severity = deleted ? "high" : "warning";
  const title = production
    ? "Production configuration changed"
    : deleted
      ? "Configuration file deleted"
      : "Configuration changed";

  return {
    id: production ? FINDING_IDS.productionConfigurationChanged : deleted ? FINDING_IDS.configurationFileDeleted : FINDING_IDS.configurationChanged,
    severity,
    category: "configuration",
    title,
    description: descriptionFor(change, production, deleted),
    files: [change.path],
    evidence: [`Change type: ${change.type}`],
  };
}

function descriptionFor(change: FileChange, production: boolean, deleted: boolean): string {
  if (deleted) {
    return "A configuration file was deleted. Confirm that runtime, deployment, or automation settings do not still depend on it.";
  }

  const scope = production ? "Production runtime configuration" : "Runtime configuration";
  return `${scope} was ${describeChange(change.type)}. Review the diff for environment-specific values, credentials, URLs, feature flags, or behavior changes.`;
}

function isProductionPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /(^|[./_-])(production|prod)([./_-]|$)/.test(normalized);
}

function describeChange(type: FileChange["type"]): string {
  switch (type) {
    case "created": return "added";
    case "modified": return "modified";
    case "deleted": return "deleted";
    case "renamed": return "renamed";
  }
}
