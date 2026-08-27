import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearCheckpoint,
  createCheckpoint,
  createCurrentSnapshot,
  loadCheckpoint,
  reviewChanges,
} from "./index.ts";

interface TestRepository {
  path: string;
  cleanup(): Promise<void>;
}

test("clean repository produces no changes, then reports only post-checkpoint modification", async () => {
  const repository = await createRepository({ "A.ts": "committed\n" });
  try {
    await createCheckpoint(repository.path);
    assert.deepEqual((await reviewChanges(repository.path)).changes.files, []);

    await write(repository.path, "A.ts", "changed after checkpoint\n");
    const result = await reviewChanges(repository.path);
    assert.deepEqual(result.changes.files, [{ type: "modified", path: "A.ts" }]);
    assert.equal((await result.content.readBefore("A.ts"))?.toString(), "committed\n");
    assert.equal((await result.content.readAfter("A.ts"))?.toString(), "changed after checkpoint\n");
  } finally {
    await repository.cleanup();
  }
});

test("pre-existing dirty, staged, and unstaged changes are baseline and real index is unchanged", async () => {
  const repository = await createRepository({
    "dirty.ts": "committed dirty\n",
    "staged.ts": "committed staged\n",
    "unstaged.ts": "committed unstaged\n",
  });
  try {
    await write(repository.path, "dirty.ts", "developer baseline\n");
    await write(repository.path, "staged.ts", "staged baseline\n");
    await git(repository.path, ["add", "--", "staged.ts"]);
    await write(repository.path, "unstaged.ts", "unstaged baseline\n");

    const indexPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);
    const statusBefore = await git(repository.path, ["status", "--porcelain=v1", "-z"]);

    await createCheckpoint(repository.path);

    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.deepEqual(await git(repository.path, ["status", "--porcelain=v1", "-z"]), statusBefore);
    assert.deepEqual((await reviewChanges(repository.path)).changes.files, []);

    await write(repository.path, "dirty.ts", "agent change\n");
    const result = await reviewChanges(repository.path);
    assert.deepEqual(result.changes.files, [{ type: "modified", path: "dirty.ts" }]);
    assert.equal((await result.content.readBefore("dirty.ts"))?.toString(), "developer baseline\n");
    assert.equal((await result.content.readAfter("dirty.ts"))?.toString(), "agent change\n");
  } finally {
    await repository.cleanup();
  }
});

test("reports created, deleted, renamed, and space-containing paths while excluding ignored files", async () => {
  const repository = await createRepository({
    ".gitignore": "ignored/\n*.ignored\n",
    "delete me.ts": "delete\n",
    "old name.ts": "rename content stays identical\n",
  });
  try {
    await createCheckpoint(repository.path);
    await write(repository.path, "new file.ts", "new\n");
    await rm(join(repository.path, "delete me.ts"));
    await mkdir(join(repository.path, "renamed"), { recursive: true });
    await rm(join(repository.path, "old name.ts"));
    await write(repository.path, "renamed/new name.ts", "rename content stays identical\n");
    await write(repository.path, "secret.ignored", "ignored\n");
    await write(repository.path, "ignored/output.txt", "ignored directory\n");

    assert.deepEqual((await reviewChanges(repository.path)).changes.files, [
      { type: "deleted", path: "delete me.ts" },
      { type: "created", path: "new file.ts" },
      { type: "renamed", previousPath: "old name.ts", path: "renamed/new name.ts" },
    ]);
  } finally {
    await repository.cleanup();
  }
});

test("includes ignored .env files without including ordinary ignored paths or mutating Git state", async () => {
  const repository = await createRepository({
    ".gitignore": ".env\n.env.production\nnode_modules/\ndist/\nobj/\n",
  });
  try {
    await createCheckpoint(repository.path);
    await write(repository.path, ".env", "MODE=development\n");
    await write(repository.path, ".env.production", "MODE=production\n");
    await write(repository.path, "node_modules/example/index.js", "ignored\n");
    await write(repository.path, "dist/app.js", "ignored\n");
    await write(repository.path, "obj/generated.cs", "ignored\n");

    const indexPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);
    const statusBefore = await git(repository.path, ["status", "--porcelain=v1", "-z", "--ignored"]);
    const gitignoreBefore = await readFile(join(repository.path, ".gitignore"), "utf8");

    const result = await reviewChanges(repository.path);
    assert.deepEqual(result.changes.files, [
      { type: "created", path: ".env" },
      { type: "created", path: ".env.production" },
    ]);
    assert.equal((await result.content.readAfter(".env"))?.toString(), "MODE=development\n");
    assert.ok(result.findings.some((finding) => finding.category === "configuration" && finding.files.includes(".env")));
    assert.deepEqual(result.risk, {
      score: 4,
      level: "medium",
      contributions: [{ reason: "Production configuration", points: 4 }],
    });
    await clearCheckpoint(repository.path);
    await createCheckpoint(repository.path);
    await write(repository.path, ".env", "MODE=changed\n");
    assert.deepEqual((await reviewChanges(repository.path)).changes.files, [
      { type: "modified", path: ".env" },
    ]);
    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.deepEqual(await git(repository.path, ["status", "--porcelain=v1", "-z", "--ignored"]), statusBefore);
    assert.equal(await readFile(join(repository.path, ".gitignore"), "utf8"), gitignoreBefore);
  } finally {
    await repository.cleanup();
  }
});
test("supports detached HEAD and invocation from a repository subdirectory", async () => {
  const repository = await createRepository({ "src/A.ts": "one\n" });
  try {
    await git(repository.path, ["checkout", "--detach", "--quiet"]);
    const subdirectory = join(repository.path, "src");
    const checkpoint = await createCheckpoint(subdirectory);
    assert.equal(checkpoint.branch, null);

    await write(repository.path, "src/A.ts", "two\n");
    const result = await reviewChanges(subdirectory);
    assert.equal(result.branchChanged, false);
    assert.equal(result.headChanged, false);
    assert.deepEqual(result.changes.files, [{ type: "modified", path: "src/A.ts" }]);
  } finally {
    await repository.cleanup();
  }
});

test("keeps checkpoint baseline and detects branch and HEAD changes", async () => {
  const repository = await createRepository({ "base.ts": "base\n" });
  try {
    const checkpoint = await createCheckpoint(repository.path);
    await git(repository.path, ["switch", "-c", "other", "--quiet"]);
    await write(repository.path, "branch.ts", "branch\n");
    await git(repository.path, ["add", "--", "branch.ts"]);
    await git(repository.path, ["commit", "-m", "branch commit", "--quiet"]);

    const result = await reviewChanges(repository.path);
    assert.equal(result.branchChanged, true);
    assert.equal(result.headChanged, true);
    assert.equal(result.checkpoint.tree, checkpoint.tree);
    assert.deepEqual(result.changes.files, [{ type: "created", path: "branch.ts" }]);
  } finally {
    await repository.cleanup();
  }
});

test("distinguishes a branch-only context change", async () => {
  const repository = await createRepository({ "base.ts": "base\n" });
  try {
    await createCheckpoint(repository.path);
    await git(repository.path, ["switch", "-c", "same-head", "--quiet"]);

    const result = await reviewChanges(repository.path);
    assert.equal(result.branchChanged, true);
    assert.equal(result.headChanged, false);
    assert.deepEqual(result.changes.files, []);
  } finally {
    await repository.cleanup();
  }
});

test("meets the M1 mixed-change acceptance scenario", async () => {
  const repository = await createRepository({
    "A.cs": "committed\n",
    "C.cs": "delete\n",
    "D.cs": "rename without content edits\n",
  });
  try {
    await write(repository.path, "A.cs", "developer baseline\n");
    await createCheckpoint(repository.path);
    await write(repository.path, "A.cs", "agent modification\n");
    await write(repository.path, "B.cs", "created\n");
    await rm(join(repository.path, "C.cs"));
    await rm(join(repository.path, "D.cs"));
    await write(repository.path, "E.cs", "rename without content edits\n");

    const files = (await reviewChanges(repository.path)).changes.files;
    assert.equal(files.filter(({ type }) => type === "modified").length, 1);
    assert.equal(files.filter(({ type }) => type === "created").length, 1);
    assert.equal(files.filter(({ type }) => type === "deleted").length, 1);
    assert.equal(files.filter(({ type }) => type === "renamed").length, 1);
    assert.deepEqual(files, [
      { type: "modified", path: "A.cs" },
      { type: "created", path: "B.cs" },
      { type: "deleted", path: "C.cs" },
      { type: "renamed", previousPath: "D.cs", path: "E.cs" },
    ]);
  } finally {
    await repository.cleanup();
  }
});

test("loads, protects, and clears checkpoint metadata and objects", async () => {
  const repository = await createRepository({ "A.ts": "one\n" });
  try {
    const created = await createCheckpoint(repository.path);
    assert.deepEqual(await loadCheckpoint(repository.path), created);
    await assert.rejects(() => createCheckpoint(repository.path), /already exists/);

    await clearCheckpoint(repository.path);
    await assert.rejects(() => loadCheckpoint(repository.path), /No active/);
    await assert.rejects(() => reviewChanges(repository.path), /No active/);

    const snapshot = await createCurrentSnapshot(repository.path);
    assert.match(snapshot.tree, /^[0-9a-f]{40,64}$/);
  } finally {
    await repository.cleanup();
  }
});

test("rejects an unborn repository with a clear error", async () => {
  const path = await mkdtemp(join(tmpdir(), "agentcheck-unborn-"));
  try {
    await git(path, ["init", "--quiet"]);
    await assert.rejects(() => createCheckpoint(path), /at least one commit/);
  } finally {
    await rm(path, { force: true, recursive: true });
  }
});

test("created submodule gitlinks do not make review content analysis fail", async () => {
  const submodule = await createRepository({ "module.ts": "module\n" });
  const repository = await createRepository({ "root.ts": "root\n" });
  try {
    await createCheckpoint(repository.path);
    await git(repository.path, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      submodule.path,
      "vendor/module",
    ]);

    const result = await reviewChanges(repository.path);
    assert.deepEqual(result.changes.files, [
      { type: "created", path: ".gitmodules" },
      { type: "created", path: "vendor/module" },
    ]);
  } finally {
    await repository.cleanup();
    await submodule.cleanup();
  }
});

async function createRepository(files: Record<string, string>): Promise<TestRepository> {
  const path = await mkdtemp(join(tmpdir(), "agentcheck-test-"));
  await git(path, ["init", "--initial-branch=main", "--quiet"]);
  await git(path, ["config", "user.name", "AgentCheck Test"]);
  await git(path, ["config", "user.email", "agentcheck@example.invalid"]);

  for (const [file, content] of Object.entries(files)) {
    await write(path, file, content);
  }

  await git(path, ["add", "-A", "--", "."]);
  await git(path, ["commit", "-m", "initial", "--quiet"]);
  return {
    path,
    cleanup: () => rm(path, { force: true, recursive: true }),
  };
}

async function write(repository: string, relativePath: string, content: string): Promise<void> {
  const path = join(repository, ...relativePath.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await git(cwd, args)).toString("utf8").trim();
}

function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.toString("utf8") || error.message, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}
