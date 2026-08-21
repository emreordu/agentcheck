import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { analyzeChanges, createCachedFileContentProvider } from "./analysis.ts";
import { assessRisk, verdictForReview } from "./risk.ts";
import {
  objectEnvironment,
  readBranch,
  readHead,
  resolveRepository,
  runGit,
  snapshotEnvironment,
  type GitRepository,
} from "./git.ts";
import type {
  ChangeSet,
  Checkpoint,
  FileChange,
  FileContentProvider,
  ReviewResult,
  Snapshot,
} from "./types.ts";

const CHECKPOINT_FILE = "checkpoint.json";

export async function createCheckpoint(cwd = process.cwd()): Promise<Checkpoint> {
  const repository = await resolveRepository(cwd);
  const checkpointPath = join(repository.agentcheckDirectory, CHECKPOINT_FILE);

  if (await fileExists(checkpointPath)) {
    throw new Error("An active AgentCheck checkpoint already exists. Clear it before creating another checkpoint.");
  }

  const snapshot = await createSnapshotForRepository(repository);
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...snapshot,
  };

  await persistCheckpoint(repository, checkpoint);
  return checkpoint;
}

export async function loadCheckpoint(cwd = process.cwd()): Promise<Checkpoint> {
  const repository = await resolveRepository(cwd);
  return loadCheckpointForRepository(repository);
}

export async function createCurrentSnapshot(cwd = process.cwd()): Promise<Snapshot> {
  const repository = await resolveRepository(cwd);
  return createSnapshotForRepository(repository);
}

export async function reviewChanges(cwd = process.cwd()): Promise<ReviewResult> {
  const repository = await resolveRepository(cwd);
  const checkpoint = await loadCheckpointForRepository(repository);
  const current = await createSnapshotForRepository(repository);
  const changes = await diffTrees(repository, checkpoint.tree, current.tree);
  const content = createCachedFileContentProvider(
    createFileContentProvider(repository, checkpoint.tree, current.tree),
  );
  const findings = await analyzeChanges({ checkpoint, changes, files: content });
  const risk = assessRisk(changes, findings);

  return {
    changes,
    findings,
    risk,
    verdict: verdictForReview(risk.level, findings),
    checkpoint,
    current,
    headChanged: checkpoint.head !== current.head,
    branchChanged: checkpoint.branch !== current.branch,
    content,
  };
}

export async function clearCheckpoint(cwd = process.cwd()): Promise<void> {
  const repository = await resolveRepository(cwd);
  await rm(join(repository.agentcheckDirectory, CHECKPOINT_FILE), { force: true });
  await rm(repository.agentcheckObjectDirectory, { force: true, recursive: true });
}

async function createSnapshotForRepository(repository: GitRepository): Promise<Snapshot> {
  const head = await readHead(repository);
  const branch = await readBranch(repository);
  await mkdir(repository.agentcheckObjectDirectory, { recursive: true });

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentcheck-index-"));
  const indexFile = join(temporaryDirectory, "index");
  const env = snapshotEnvironment(repository, indexFile);

  try {
    await runGit(repository.root, ["read-tree", "HEAD"], { env });
    await runGit(repository.root, ["add", "-A", "--", "."], { env });
    const tree = (await runGit(repository.root, ["write-tree"], { env })).toString("utf8").trim();
    return { head, branch, tree };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function diffTrees(
  repository: GitRepository,
  beforeTree: string,
  afterTree: string,
): Promise<ChangeSet> {
  const output = await runGit(
    repository.root,
    ["diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "-M", beforeTree, afterTree],
    { env: objectEnvironment(repository) },
  );

  const tokens = splitNullDelimited(output);
  const files: FileChange[] = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) {
      throw new Error("Git returned an invalid empty change status.");
    }

    if (status.startsWith("R")) {
      const previousPath = requiredToken(tokens[index++], status);
      const path = requiredToken(tokens[index++], status);
      files.push({ type: "renamed", previousPath, path });
      continue;
    }

    const path = requiredToken(tokens[index++], status);
    switch (status[0]) {
      case "A":
        files.push({ type: "created", path });
        break;
      case "D":
        files.push({ type: "deleted", path });
        break;
      case "M":
      case "T":
        files.push({ type: "modified", path });
        break;
      default:
        throw new Error(`Unsupported Git change status: ${status}`);
    }
  }

  return { files };
}

function createFileContentProvider(
  repository: GitRepository,
  beforeTree: string,
  afterTree: string,
): FileContentProvider {
  return {
    readBefore: (path) => readTreeFile(repository, beforeTree, path),
    readAfter: (path) => readTreeFile(repository, afterTree, path),
  };
}

async function readTreeFile(
  repository: GitRepository,
  tree: string,
  path: string,
): Promise<Buffer | null> {
  const env = objectEnvironment(repository);
  const entry = await runGit(repository.root, ["ls-tree", "-z", tree, "--", `:(literal)${path}`], { env });
  if (entry.length === 0) {
    return null;
  }

  const tab = entry.indexOf(0x09);
  if (tab < 0) {
    throw new Error(`Git returned an invalid tree entry for ${path}.`);
  }

  const metadata = entry.subarray(0, tab).toString("utf8").split(" ");
  const objectType = metadata[1];
  const objectId = metadata[2];
  if (!objectId) {
    throw new Error(`Git returned an invalid object id for ${path}.`);
  }
  if (objectType !== "blob") {
    return null;
  }

  return runGit(repository.root, ["cat-file", "blob", objectId], { env });
}

async function persistCheckpoint(repository: GitRepository, checkpoint: Checkpoint): Promise<void> {
  await mkdir(repository.agentcheckDirectory, { recursive: true });
  const checkpointPath = join(repository.agentcheckDirectory, CHECKPOINT_FILE);
  const temporaryPath = join(
    repository.agentcheckDirectory,
    `${basename(CHECKPOINT_FILE)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, checkpointPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function loadCheckpointForRepository(repository: GitRepository): Promise<Checkpoint> {
  const checkpointPath = join(repository.agentcheckDirectory, CHECKPOINT_FILE);
  let value: unknown;

  try {
    value = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error("No active AgentCheck checkpoint exists. Create a checkpoint before reviewing changes.", { cause: error });
    }
    throw new Error("The AgentCheck checkpoint metadata could not be read.", { cause: error });
  }

  if (!isCheckpoint(value)) {
    throw new Error("The AgentCheck checkpoint metadata is invalid or uses an unsupported schema version.");
  }

  return value;
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 1
    && typeof candidate.createdAt === "string"
    && typeof candidate.head === "string"
    && (typeof candidate.branch === "string" || candidate.branch === null)
    && typeof candidate.tree === "string";
}

function splitNullDelimited(value: Buffer): string[] {
  if (value.length === 0) return [];
  const tokens = value.toString("utf8").split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

function requiredToken(value: string | undefined, status: string): string {
  if (value === undefined) {
    throw new Error(`Git returned an incomplete path list for status ${status}.`);
  }
  return value;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
