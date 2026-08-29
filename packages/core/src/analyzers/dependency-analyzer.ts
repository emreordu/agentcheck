import { FINDING_IDS } from "../stable-ids.ts";
import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

const PACKAGE_JSON_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const TIER_TWO_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "packages.lock.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pyproject.toml",
  "poetry.lock",
  "pubspec.lock",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
]);

interface DependencyEntry {
  name: string;
  source?: string;
}

export class DependencyAnalyzer implements Analyzer {
  readonly name = "dependency";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const change of context.changes.files) {
      const kind = semanticKind(change.path);
      if (kind) {
        findings.push(...await analyzeSemanticManifest(context, change, kind));
      } else if (isTierTwoManifest(change.path)) {
        findings.push(genericManifestFinding(change));
      }
    }

    return findings;
  }
}

type SemanticKind = "package-json" | "csproj" | "central-packages" | "requirements";

async function analyzeSemanticManifest(
  context: AnalysisContext,
  change: FileChange,
  kind: SemanticKind,
): Promise<Finding[]> {
  const beforePath = change.type === "renamed" ? change.previousPath ?? change.path : change.path;
  const [before, after] = await Promise.all([
    context.files.readBefore(beforePath),
    context.files.readAfter(change.path),
  ]);

  if (after === null) return [];

  try {
    const beforeDependencies = before === null ? [] : parseManifest(kind, before.toString("utf8"));
    const afterDependencies = parseManifest(kind, after.toString("utf8"));
    const previousNames = new Set(beforeDependencies.map((dependency) => dependency.name.toLowerCase()));

    return afterDependencies
      .filter((dependency) => !previousNames.has(dependency.name.toLowerCase()))
      .map((dependency) => dependencyAddedFinding(change.path, dependency));
  } catch {
    return [unparsedManifestFinding(change)];
  }
}

function parseManifest(kind: SemanticKind, content: string): DependencyEntry[] {
  switch (kind) {
    case "package-json": return parsePackageJson(content);
    case "csproj": return parseXmlItems(content, "PackageReference");
    case "central-packages": return parseXmlItems(content, "PackageVersion");
    case "requirements": return parseRequirements(content);
  }
}

function parsePackageJson(content: string): DependencyEntry[] {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package.json root must be an object");
  }

  const manifest = value as Record<string, unknown>;
  const dependencies: DependencyEntry[] = [];

  for (const section of PACKAGE_JSON_SECTIONS) {
    const candidate = manifest[section];
    if (candidate === undefined) continue;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`${section} must be an object`);
    }

    for (const name of Object.keys(candidate).sort((left, right) => left.localeCompare(right, "en"))) {
      dependencies.push({ name, source: section });
    }
  }

  return dependencies;
}

function parseXmlItems(content: string, elementName: string): DependencyEntry[] {
  const dependencies: DependencyEntry[] = [];
  const elementPattern = new RegExp(`<${elementName}\\b[^>]*>`, "gi");

  let uncommentedContent = content;
  let previous: string;

  do {
    previous = uncommentedContent;
    uncommentedContent = uncommentedContent.replace(/<!--[\s\S]*?-->/g, "");
  } while (uncommentedContent !== previous);

  for (const match of uncommentedContent.matchAll(elementPattern)) {
    const element = match[0];
    const include = /\bInclude\s*=\s*["']([^"']+)["']/i.exec(element)?.[1];
    if (include) dependencies.push({ name: include });
  }

  return uniqueDependencies(dependencies);
}

function parseRequirements(content: string): DependencyEntry[] {
  const dependencies: DependencyEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    if (line.includes("://") || line.toLowerCase().startsWith("git+")) continue;

    const withoutComment = line.replace(/\s+#.*$/, "").trim();
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)/.exec(withoutComment)?.[1];
    if (name) dependencies.push({ name: normalizePythonName(name) });
  }

  return uniqueDependencies(dependencies);
}

function uniqueDependencies(dependencies: DependencyEntry[]): DependencyEntry[] {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = dependency.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePythonName(name: string): string {
  const extrasIndex = name.indexOf("[");
  const packageName = extrasIndex < 0 ? name : name.slice(0, extrasIndex);
  const extras = extrasIndex < 0 ? "" : name.slice(extrasIndex).toLowerCase();
  return `${packageName.toLowerCase().replace(/[._-]+/g, "-")}${extras}`;
}

function semanticKind(path: string): SemanticKind | null {
  const basename = getBasename(path);
  if (basename === "package.json") return "package-json";
  if (basename.endsWith(".csproj")) return "csproj";
  if (basename === "directory.packages.props") return "central-packages";
  if (basename === "requirements.txt") return "requirements";
  return null;
}

function isTierTwoManifest(path: string): boolean {
  return TIER_TWO_BASENAMES.has(getBasename(path));
}

function getBasename(path: string): string {
  return (path.replaceAll("\\", "/").split("/").at(-1) ?? "").toLowerCase();
}

function dependencyAddedFinding(path: string, dependency: DependencyEntry): Finding {
  return {
    id: FINDING_IDS.dependencyAdded,
    severity: "warning",
    category: "dependency",
    title: "Dependency added",
    description: `${dependency.name} was added to this manifest. Review its source, version, license, and compatibility with the project.`,
    files: [path],
    evidence: [
      `Dependency: ${dependency.name}`,
      `Manifest: ${path}`,
      ...(dependency.source ? [`Section: ${dependency.source}`] : []),
    ],
  };
}

function genericManifestFinding(change: FileChange): Finding {
  return {
    id: FINDING_IDS.dependencyConfigurationChanged,
    severity: "warning",
    category: "dependency",
    title: "Dependency configuration changed",
    description: `A dependency manifest was ${describeChange(change.type)}. Review the diff for added, removed, or updated packages and lockfile implications.`,
    files: [change.path],
    evidence: ["No semantic parser is enabled for this manifest type."],
  };
}

function unparsedManifestFinding(change: FileChange): Finding {
  return {
    id: FINDING_IDS.dependencyConfigurationChanged,
    severity: "warning",
    category: "dependency",
    title: "Dependency configuration changed",
    description: "A dependency manifest changed but could not be compared semantically. Inspect the diff for package and version changes.",
    files: [change.path],
    evidence: ["Semantic comparison was unavailable because the manifest content was invalid."],
  };
}

function describeChange(type: FileChange["type"]): string {
  switch (type) {
    case "created": return "added";
    case "modified": return "modified";
    case "deleted": return "deleted";
    case "renamed": return "renamed";
  }
}
