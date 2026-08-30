import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export function validatePackageMetadata(packageJson, expectedName) {
  if (!isRecord(packageJson)) fail(expectedName, "package.json must contain an object.");
  if (packageJson.name !== expectedName) fail(expectedName, `package name must be \`${expectedName}\`, found \`${String(packageJson.name)}\`.`);
  if (typeof packageJson.version !== "string" || !isValidVersion(packageJson.version)) {
    fail(expectedName, "package.json version must be a valid semantic version.");
  }
  if (typeof packageJson.main !== "string" || packageJson.main.length === 0) fail(expectedName, "package.json main must be a non-empty path.");
  if (typeof packageJson.types !== "string" || packageJson.types.length === 0) fail(expectedName, "package.json types must be a non-empty path.");
  if (!isRecord(packageJson.exports)) fail(expectedName, "package.json exports must be present.");
  if (!Array.isArray(packageJson.files) || !packageJson.files.every((value) => typeof value === "string")) {
    fail(expectedName, "package.json files must be an array of paths.");
  }
}

export function validatePackedNpmArtifact(packageJson, files) {
  const packageName = packageJson.name;
  const packedFiles = new Set(files.map(normalizeArtifactPath));
  for (const [label, target] of declaredEntrypoints(packageJson)) {
    const normalized = normalizeContractPath(packageName, target);
    if (!packedFiles.has(normalized)) {
      fail(packageName, `declared ${label} \`${normalized}\` is missing from packed artifact. Rebuild the package and check package files metadata.`);
    }
  }
  for (const required of ["README.md", "LICENSE", "package.json"]) {
    if (!packedFiles.has(required)) fail(packageName, `packed artifact is missing required \`${required}\`.`);
  }
  return packedFiles;
}

export function validateCliVersion(packageJson, reportedVersion) {
  if (reportedVersion !== packageJson.version) {
    fail(packageJson.name, `installed agentcheck --version returned \`${reportedVersion}\`, expected \`${packageJson.version}\`.`);
  }
}

export function validateVsixArtifact(packageJson, entries) {
  const packageName = packageJson.name;
  if (!isRecord(packageJson.vsce) || packageJson.vsce.dependencies !== false) {
    fail(packageName, "vsce.dependencies must remain false so workspace dependencies are not bundled.");
  }
  const files = new Set(entries.map(normalizeArtifactPath));
  const foldedFiles = new Set([...files].map((file) => file.toLowerCase()));
  if (!foldedFiles.has("extension/package.json")) fail(packageName, "VSIX is missing required extension/package.json.");
  if (!foldedFiles.has("extension/readme.md")) fail(packageName, "VSIX is missing required README documentation.");
  if (!["extension/license", "extension/license.md", "extension/license.txt"].some((path) => foldedFiles.has(path))) {
    fail(packageName, "VSIX is missing required license documentation.");
  }
  const main = normalizeContractPath(packageName, packageJson.main);
  if (!files.has(`extension/${main}`)) fail(packageName, `declared extension main \`${main}\` is missing from VSIX.`);
  if (typeof packageJson.icon !== "string" || !files.has(`extension/${normalizeContractPath(packageName, packageJson.icon)}`)) {
    fail(packageName, "declared extension icon is missing from VSIX.");
  }
  for (const command of packageJson.contributes?.commands ?? []) {
    if (typeof command?.command !== "string" || command.command.length === 0) fail(packageName, "a contributed command is missing its command id.");
  }
  for (const container of packageJson.contributes?.viewsContainers?.activitybar ?? []) {
    if (typeof container?.icon === "string" && !files.has(`extension/${normalizeContractPath(packageName, container.icon)}`)) {
      fail(packageName, `declared activity-bar icon \`${container.icon}\` is missing from VSIX.`);
    }
  }
  if ([...files].some((file) => file.startsWith("extension/node_modules/") || file.startsWith("extension/src/"))) {
    fail(packageName, "VSIX contains excluded dependency or source files.");
  }
}

export function normalizeArtifactPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function declaredEntrypoints(packageJson) {
  const entries = [];
  if (typeof packageJson.main === "string") entries.push(["main", packageJson.main]);
  if (typeof packageJson.types === "string") entries.push(["types", packageJson.types]);
  for (const target of exportTargets(packageJson.exports)) entries.push(["exports", target]);
  for (const [name, target] of Object.entries(packageJson.bin ?? {})) entries.push([`bin.${name}`, target]);
  return entries;
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(exportTargets);
}

function normalizeContractPath(packageName, target) {
  if (typeof target !== "string" || target.length === 0) fail(packageName, "declared entrypoint must be a non-empty path.");
  const normalized = normalizeArtifactPath(target);
  const resolved = resolve("package-root", normalized);
  const fromRoot = relative("package-root", resolved);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || posix.normalize(normalized).startsWith("../")) {
    fail(packageName, `declared entrypoint \`${target}\` resolves outside the package.`);
  }
  return normalizeArtifactPath(fromRoot);
}

function isValidVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(packageName, message) {
  throw new Error(`${packageName}: ${message}`);
}
