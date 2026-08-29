import { FINDING_IDS } from "../stable-ids.ts";
import { actionForFinding } from "../finding-actions.ts";
import type { AnalysisContext, Analyzer, DependencyDelta, FileChange, Finding } from "../types.ts";

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
  version?: string;
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

  // Whole-manifest deletion remains deliberately bounded: file-change reporting already
  // identifies the deletion, but we do not expand it into one finding per old dependency.
  if (after === null) return [];

  try {
    const beforeDependencies = before === null ? [] : parseManifest(kind, before.toString("utf8"));
    const afterDependencies = parseManifest(kind, after.toString("utf8"));
    const deltas = compareDependencies(beforeDependencies, afterDependencies);

    return deltas.map((delta) => dependencyDeltaFinding(change.path, delta, dependencySource(delta, beforeDependencies, afterDependencies)));
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

    const values = candidate as Record<string, unknown>;
    for (const name of Object.keys(values).sort((left, right) => left.localeCompare(right, "en"))) {
      dependencies.push({ name, version: literalVersion(values[name]), source: section });
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
    if (include) dependencies.push({
      name: include,
      version: literalVersion(/\bVersion\s*=\s*["']([^"']+)["']/i.exec(element)?.[1]),
    });
  }

  return dependencies;
}

function parseRequirements(content: string): DependencyEntry[] {
  const dependencies: DependencyEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    if (line.includes("://") || line.toLowerCase().startsWith("git+")) continue;

    const withoutComment = line.replace(/\s+#.*$/, "").trim();
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)/.exec(withoutComment);
    if (!match) continue;

    dependencies.push({
      name: normalizePythonName(match[1]!),
      version: literalVersion(withoutComment.slice(match[0].length).trim()),
    });
  }

  return dependencies;
}

function compareDependencies(
  beforeDependencies: readonly DependencyEntry[],
  afterDependencies: readonly DependencyEntry[],
): DependencyDelta[] {
  const before = dependencyMap(beforeDependencies);
  const after = dependencyMap(afterDependencies);
  const deltas: DependencyDelta[] = [];

  for (const [identity, current] of after) {
    const previous = before.get(identity);
    if (!previous) {
      deltas.push({ kind: "added", name: current.name, ...(current.version ? { currentVersion: current.version } : {}) });
      continue;
    }
    if (previous.version && current.version && previous.version !== current.version) {
      deltas.push({ kind: "updated", name: current.name, previousVersion: previous.version, currentVersion: current.version });
    }
  }

  for (const [identity, previous] of before) {
    if (!after.has(identity)) {
      deltas.push({ kind: "removed", name: previous.name, ...(previous.version ? { previousVersion: previous.version } : {}) });
    }
  }

  return deltas.sort(compareDependencyDeltas);
}

function dependencyMap(entries: readonly DependencyEntry[]): Map<string, DependencyEntry> {
  const dependencies = new Map<string, DependencyEntry>();

  for (const entry of entries) {
    const identity = entry.name.toLowerCase();
    const existing = dependencies.get(identity);
    if (existing && existing.version !== entry.version) {
      throw new Error("Dependency identity has ambiguous literal versions");
    }
    if (!existing) dependencies.set(identity, entry);
  }

  return dependencies;
}

function compareDependencyDeltas(left: DependencyDelta, right: DependencyDelta): number {
  return dependencyDeltaRank(left.kind) - dependencyDeltaRank(right.kind)
    || left.name.localeCompare(right.name, "en")
    || (left.previousVersion ?? "").localeCompare(right.previousVersion ?? "", "en")
    || (left.currentVersion ?? "").localeCompare(right.currentVersion ?? "", "en");
}

function dependencyDeltaRank(kind: DependencyDelta["kind"]): number {
  switch (kind) {
    case "added": return 0;
    case "removed": return 1;
    case "updated": return 2;
  }
}

function dependencySource(
  delta: DependencyDelta,
  beforeDependencies: readonly DependencyEntry[],
  afterDependencies: readonly DependencyEntry[],
): string | undefined {
  const entries = delta.kind === "removed" ? beforeDependencies : afterDependencies;
  return entries.find((entry) => entry.name.toLowerCase() === delta.name.toLowerCase())?.source;
}

function literalVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const literal = value.trim();
  if (!literal || /\s/.test(literal)) return undefined;
  if (literal.includes("://") || literal.startsWith("@") || literal.includes(" @ ")) return undefined;
  if (/^(?:git\+|file:|link:|workspace:|npm:|github:|gitlab:|bitbucket:|ssh:)/i.test(literal)) return undefined;
  return literal;
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

function dependencyDeltaFinding(path: string, delta: DependencyDelta, source: string | undefined): Finding {
  const id = delta.kind === "added"
    ? FINDING_IDS.dependencyAdded
    : delta.kind === "removed"
    ? FINDING_IDS.dependencyRemoved
    : FINDING_IDS.dependencyUpdated;

  return {
    id,
    severity: "warning",
    category: "dependency",
    title: `Dependency ${delta.kind}`,
    description: "A dependency literal changed. Review the manifest change in its project context.",
    action: actionForFinding(id),
    files: [path],
    dependencyDeltas: [delta],
    evidence: [
      formatDependencyDelta(delta),
      `Manifest: ${path}`,
      ...(source ? [`Section: ${source}`] : []),
    ],
  };
}

function formatDependencyDelta(delta: DependencyDelta): string {
  switch (delta.kind) {
    case "added": return `Added: ${delta.name}${delta.currentVersion ? ` @ ${delta.currentVersion}` : ""}`;
    case "removed": return `Removed: ${delta.name}${delta.previousVersion ? ` @ ${delta.previousVersion}` : ""}`;
    case "updated": return `Updated: ${delta.name} ${delta.previousVersion} → ${delta.currentVersion}`;
  }
}

function genericManifestFinding(change: FileChange): Finding {
  return {
    id: FINDING_IDS.dependencyConfigurationChanged,
    severity: "warning",
    category: "dependency",
    title: "Dependency configuration changed",
    description: `A dependency manifest was ${describeChange(change.type)}. Review the diff for added, removed, or updated packages and lockfile implications.`,
    action: actionForFinding(FINDING_IDS.dependencyConfigurationChanged),
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
    action: actionForFinding(FINDING_IDS.dependencyConfigurationChanged),
    files: [change.path],
    evidence: ["Semantic comparison was unavailable because the manifest content was invalid or ambiguous."],
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
