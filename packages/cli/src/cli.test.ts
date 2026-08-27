import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReviewResult } from "@agentcheck/core";
import { formatReview } from "./presentation.ts";
import { createProgress } from "./progress.ts";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TestRepository {
  path: string;
  cleanup(): Promise<void>;
}

const cliEntry = join(import.meta.dirname, "index.js");

test("start creates a checkpoint and refuses to overwrite it", async () => {
  const repository = await createRepository({ "A.ts": "one\n" });
  try {
    const first = await agentcheck(repository.path, ["start"]);
    assert.equal(first.exitCode, 0);
    assert.match(first.stdout, /^✓ Checkpoint created\nBranch: main\nCommit: [0-9a-f]{7}\n$/);
    assert.equal(first.stderr, "");

    const checkpointPath = await gitText(repository.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "agentcheck/checkpoint.json",
    ]);
    const checkpointBefore = await readFile(checkpointPath, "utf8");

    const second = await agentcheck(repository.path, ["start"]);
    assert.equal(second.exitCode, 1);
    assert.match(second.stderr, /already has an active checkpoint/);
    assert.match(second.stderr, /agentcheck clear/);
    assert.equal(await readFile(checkpointPath, "utf8"), checkpointBefore);
  } finally {
    await repository.cleanup();
  }
});

test("argumentless check and check alias print the mixed-change summary", async () => {
  const repository = await createRepository({
    "A.ts": "original\n",
    "C.ts": "delete\n",
    "D.ts": "rename unchanged\n",
  });
  try {
    assert.equal((await agentcheck(repository.path, ["start"])).exitCode, 0);
    await write(repository.path, "A.ts", "modified\n");
    await write(repository.path, "B.ts", "created\n");
    await rm(join(repository.path, "C.ts"));
    await rm(join(repository.path, "D.ts"));
    await write(repository.path, "E.ts", "rename unchanged\n");

    const defaultCheck = await agentcheck(repository.path, []);
    assert.equal(defaultCheck.exitCode, 0);
    assert.equal(defaultCheck.stderr, "");
    assert.match(defaultCheck.stdout, /1 finding · 1 WARNING/);
    assert.match(defaultCheck.stdout, /◆  WARNING  Tests may need review/);
    assert.match(defaultCheck.stdout, /  A\.ts\n  B\.ts\n  C\.ts/);
    assert.match(defaultCheck.stdout, /1 WARNING · Risk MEDIUM \(4\)/);
    assert.match(defaultCheck.stdout, /→ Deleted file\n→ Tests may need review/);

    const aliasCheck = await agentcheck(repository.path, ["check"]);
    assert.deepEqual(aliasCheck, defaultCheck);
  } finally {
    await repository.cleanup();
  }
});

test("no changes is a successful result", async () => {
  const repository = await createRepository({ "A.ts": "one\n" });
  try {
    await agentcheck(repository.path, ["start"]);
    assert.deepEqual(await agentcheck(repository.path, []), {
      exitCode: 0,
      stdout: "AgentCheck\n\n✓ No changes since checkpoint.\n",
      stderr: "",
    });
  } finally {
    await repository.cleanup();
  }
});

test("check without a checkpoint returns a concise user-facing error", async () => {
  const repository = await createRepository({ "A.ts": "one\n" });
  try {
    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "No active AgentCheck checkpoint.\n\nRun:\n  agentcheck start\n");
    assert.doesNotMatch(result.stderr, /at |Error:/);
  } finally {
    await repository.cleanup();
  }
});

test("a corrupted checkpoint returns an actionable user-facing error", async () => {
  const repository = await createRepository({ "A.ts": "one\n" });
  try {
    await agentcheck(repository.path, ["start"]);
    const checkpointPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "agentcheck/checkpoint.json"]);
    await writeFile(checkpointPath, "{not json}\n", "utf8");

    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "The active AgentCheck checkpoint is corrupted or unsupported.\n\nRun:\n  agentcheck clear\n  agentcheck start\n");
    assert.doesNotMatch(result.stderr, /at |Error:/);
  } finally {
    await repository.cleanup();
  }
});

test("clear removes the checkpoint and leaves the repository without a baseline", async () => {
  const repository = await createRepository({ "A.ts": "one\n" });
  try {
    await agentcheck(repository.path, ["start"]);
    assert.deepEqual(await agentcheck(repository.path, ["clear"]), {
      exitCode: 0,
      stdout: "✓ Checkpoint cleared\n",
      stderr: "",
    });

    const check = await agentcheck(repository.path, []);
    assert.equal(check.exitCode, 1);
    assert.match(check.stderr, /No active AgentCheck checkpoint/);
  } finally {
    await repository.cleanup();
  }
});

test("dirty pre-checkpoint content is baseline and only a later edit is reported", async () => {
  const repository = await createRepository({ "A.ts": "committed\n" });
  try {
    await write(repository.path, "A.ts", "developer baseline\n");
    await agentcheck(repository.path, ["start"]);
    assert.match((await agentcheck(repository.path, [])).stdout, /No changes since checkpoint/);

    await write(repository.path, "A.ts", "agent edit\n");
    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /1 modified/);
    assert.match(result.stdout, /M  A\.ts/);
  } finally {
    await repository.cleanup();
  }
});

test("start and check preserve the real Git index", async () => {
  const repository = await createRepository({ "A.ts": "one\n", "B.ts": "one\n" });
  try {
    await write(repository.path, "A.ts", "staged\n");
    await git(repository.path, ["add", "--", "A.ts"]);
    await write(repository.path, "B.ts", "unstaged\n");

    const indexPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);
    const statusBefore = await git(repository.path, ["status", "--porcelain=v1", "-z"]);

    assert.equal((await agentcheck(repository.path, ["start"])).exitCode, 0);
    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.deepEqual(await git(repository.path, ["status", "--porcelain=v1", "-z"]), statusBefore);

    await write(repository.path, "B.ts", "changed after checkpoint\n");
    assert.equal((await agentcheck(repository.path, [])).exitCode, 0);
    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.deepEqual(await git(repository.path, ["status", "--porcelain=v1", "-z"]), statusBefore);
  } finally {
    await repository.cleanup();
  }
});

test("prints repository context changes without resetting the baseline", async () => {
  const repository = await createRepository({ "base.ts": "base\n" });
  try {
    await agentcheck(repository.path, ["start"]);
    const previousHead = await gitText(repository.path, ["rev-parse", "HEAD"]);
    await git(repository.path, ["switch", "-c", "feature/test", "--quiet"]);
    await write(repository.path, "branch.ts", "branch\n");
    await git(repository.path, ["add", "--", "branch.ts"]);
    await git(repository.path, ["commit", "-m", "branch", "--quiet"]);
    const currentHead = await gitText(repository.path, ["rev-parse", "HEAD"]);

    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Repository context changed since checkpoint\./);
    assert.match(result.stdout, /main → feature\/test/);
    assert.match(result.stdout, new RegExp(`${previousHead.slice(0, 7)} → ${currentHead.slice(0, 7)}`));
    assert.match(result.stdout, /A  branch\.ts/);
  } finally {
    await repository.cleanup();
  }
});

test("reports deterministic M3 findings while preserving the real Git index", async () => {
  const repository = await createRepository({
    "OrderService.ts": "export const order = 1;\n",
    "appsettings.Production.json": "{\"Mode\":\"safe\"}\n",
    "package.json": "{\"dependencies\":{\"existing\":\"1.0.0\"}}\n",
  });
  try {
    const indexPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);
    await agentcheck(repository.path, ["start"]);
    assert.deepEqual(await readFile(indexPath), indexBefore);

    await write(repository.path, "OrderService.ts", "export const order = 2;\n");
    await write(repository.path, "appsettings.Production.json", "{\"Mode\":\"review\"}\n");
    await write(repository.path, "package.json", "{\"dependencies\":{\"existing\":\"1.0.0\",\"polly\":\"1.0.0\"}}\n");
    await write(repository.path, "Migrations/20260819_AddOrderIndex.cs", "// migration\n");

    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /3 modified\n1 created\n0 deleted\n0 renamed/);
    assert.match(result.stdout, /▲  HIGH  Database migration added/);
    assert.match(result.stdout, /◆  WARNING  Production configuration changed/);
    assert.match(result.stdout, /◆  WARNING  Dependency added/);
    assert.match(result.stdout, /Dependency: polly/);
    assert.match(result.stdout, /3 findings · 1 HIGH · 2 WARNING/);
    assert.match(result.stdout, /Score: 12 — HIGH/);
    assert.match(result.stdout, /CAREFUL REVIEW RECOMMENDED/);
    assert.match(result.stdout, /One or more high-severity findings require careful inspection before commit\./);

    const migrationIndex = result.stdout.indexOf("Database migration added");
    const configurationIndex = result.stdout.indexOf("Production configuration changed");
    const dependencyIndex = result.stdout.indexOf("Dependency added");
    assert.ok(migrationIndex < configurationIndex && configurationIndex < dependencyIndex);
    assert.deepEqual(await readFile(indexPath), indexBefore);

    const repeated = await agentcheck(repository.path, []);
    assert.equal(repeated.stdout, result.stdout);
  } finally {
    await repository.cleanup();
  }
});

test("reports complete M4 risk workflow without leaking a possible secret", async () => {
  const fakeCredential = "M4-FakeCredential-987!";
  const repository = await createRepository({
    "src/OrderService.ts": lines("before", 25),
    "appsettings.Production.json": "{\"Mode\":\"safe\"}\n",
    "package.json": "{\"dependencies\":{\"existing\":\"1.0.0\"}}\n",
    "src/OldService.ts": "export const old = true;\n",
  });
  try {
    const indexPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);
    assert.equal((await agentcheck(repository.path, ["start"])).exitCode, 0);
    assert.deepEqual(await readFile(indexPath), indexBefore);

    await write(repository.path, "src/OrderService.ts", lines("after", 25));
    await write(
      repository.path,
      "appsettings.Production.json",
      `{\n  \"Mode\": \"review\",\n  \"Password\": \"${fakeCredential}\"\n}\n`,
    );
    await write(repository.path, "package.json", "{\"dependencies\":{\"existing\":\"1.0.0\",\"polly\":\"1.0.0\"}}\n");
    await write(repository.path, "Migrations/20260819_AddOrderIndex.cs", "// migration\n");
    await rm(join(repository.path, "src/OldService.ts"));

    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /3 modified\n1 created\n1 deleted\n0 renamed/);
    assert.match(result.stdout, /Database migration added/);
    assert.match(result.stdout, /Possible secret/);
    assert.match(result.stdout, /Production configuration changed/);
    assert.match(result.stdout, /Dependency added/);
    assert.match(result.stdout, /Tests may need review/);
    assert.match(result.stdout, /Matched value: \*\*\*\*\*\*\*\*/);
    if (result.stdout.includes(fakeCredential)) {
      assert.fail("A fake credential was exposed in CLI output.");
    }
    assert.match(result.stdout, /\+5 Database migration/);
    assert.match(result.stdout, /\+5 Possible secret/);
    assert.match(result.stdout, /\+4 Production configuration/);
    assert.match(result.stdout, /\+3 Dependency addition/);
    assert.match(result.stdout, /\+3 Deleted file/);
    assert.match(result.stdout, /\+1 Tests may need review/);
    assert.match(result.stdout, /Score: 21 — HIGH/);
    assert.match(result.stdout, /Based on 6 distinct risk signals; changed-file counts are shown separately\./);
    assert.match(result.stdout, /CAREFUL REVIEW RECOMMENDED/);
    assert.match(result.stdout, /One or more high-severity findings require careful inspection before commit\./);
    assert.deepEqual(await readFile(indexPath), indexBefore);

    const repeated = await agentcheck(repository.path, []);
    assert.equal(repeated.stdout, result.stdout);
  } finally {
    await repository.cleanup();
  }
});

test("a small source change produces a low routine assessment without safety claims", async () => {
  const repository = await createRepository({ "src/value.ts": "export const value = 1;\n" });
  try {
    await agentcheck(repository.path, ["start"]);
    await write(repository.path, "src/value.ts", "export const value = 2;\n");
    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Score: 0 — LOW/);
    assert.match(result.stdout, /LOOKS ROUTINE/);
    assert.match(result.stdout, /No high-risk patterns were detected\./);
    assert.match(result.stdout, /Review the diff normally before committing\./);
    assert.doesNotMatch(result.stdout, /safe to commit|approved|ready to merge/i);
  } finally {
    await repository.cleanup();
  }
});

test("configuration warnings contribute risk once and recommend review", async () => {
  const repository = await createRepository({
    ".env": "MODE=one\n",
    "src/appsettings.json": "{\"Mode\":\"one\"}\n",
  });
  try {
    await agentcheck(repository.path, ["start"]);
    await write(repository.path, ".env", "MODE=two\n");
    await write(repository.path, "src/appsettings.json", "{\"Mode\":\"two\"}\n");

    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal((result.stdout.match(/\+1 Configuration changed/g) ?? []).length, 1);
    assert.match(result.stdout, /Score: 1 — LOW/);
    assert.match(result.stdout, /REVIEW RECOMMENDED/);
    assert.doesNotMatch(result.stdout, /LOOKS ROUTINE/);
  } finally {
    await repository.cleanup();
  }
});

test("production changes with related tests remain routine when analyzers report no findings", async () => {
  const repository = await createRepository({
    "src/OrderService.ts": lines("before", 20),
    "tests/OrderService.test.ts": "test before\n",
  });
  try {
    await agentcheck(repository.path, ["start"]);
    await write(repository.path, "src/OrderService.ts", lines("after", 20));
    await write(repository.path, "tests/OrderService.test.ts", "test after\n");

    const result = await agentcheck(repository.path, []);
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /Tests may need review/);
    assert.match(result.stdout, /Score: 0 — LOW/);
    assert.match(result.stdout, /LOOKS ROUTINE/);
    assert.match(result.stdout, /No high-risk patterns were detected\./);
    assert.match(result.stdout, /Review the diff normally before committing\./);
  } finally {
    await repository.cleanup();
  }
});

test("help, version, detached HEAD, unknown commands, and non-repository errors are concise", async () => {
  const repository = await createRepository({ "A.ts": "one\n" });
  const outsideRepository = await mkdtemp(join(tmpdir(), "agentcheck-outside-"));
  try {
    const help = await agentcheck(repository.path, ["--help"]);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /Independent change verification/);
    assert.match(help.stdout, /agentcheck start/);

    assert.deepEqual(await agentcheck(repository.path, ["--version"]), {
      exitCode: 0,
      stdout: "0.1.4\n",
      stderr: "",
    });

    await git(repository.path, ["checkout", "--detach", "--quiet"]);
    assert.match((await agentcheck(repository.path, ["start"])).stdout, /Branch: detached HEAD/);

    const unknown = await agentcheck(repository.path, ["wat"]);
    assert.equal(unknown.exitCode, 1);
    assert.match(unknown.stderr, /Unknown command: wat/);

    const outside = await agentcheck(outsideRepository, ["start"]);
    assert.equal(outside.exitCode, 1);
    assert.match(outside.stderr, /This directory is not inside a Git repository\./);
    assert.doesNotMatch(outside.stderr, /at |Error:/);
  } finally {
    await repository.cleanup();
    await rm(outsideRepository, { force: true, recursive: true });
  }
});


test("interactive presentation adds hierarchy and colors without changing result text", () => {
  const result = sampleReviewResult();
  const output = formatReview(result, { interactive: true, color: true, durationMs: 384 });

  assert.match(output, /AGENTCHECK/);
  assert.match(output, /▲  HIGH/);
  assert.match(output, /⚠  CAREFUL REVIEW RECOMMENDED/);
  assert.match(output, /Database migration added/);
  assert.match(output, /CAREFUL REVIEW RECOMMENDED/);
  assert.match(output, /Review completed in 384ms/);
  assert.match(output, /\u001B\[/);
});

test("interactive presentation keeps decision-bearing prose readable", () => {
  const output = formatReview(sampleReviewResult(), { interactive: true, color: true });

  assert.match(output, /\u001B\[1;91m▲  HIGH/);
  assert.match(output, /\u001B\[1;33m◆  WARNING/);
  assert.match(output, /\u001B\[1;32mA/);
  assert.match(output, /\u001B\[2m╭/);
  assert.doesNotMatch(output, /\u001B\[2mA migration-related file was added/);
  assert.doesNotMatch(output, /\u001B\[2mOne or more high-severity findings/);
});
test("NO_COLOR-style rendering keeps the rich report readable without ANSI sequences", () => {
  const output = formatReview(sampleReviewResult(), { interactive: true, color: false });

  assert.match(output, /◈ Review/);
  assert.match(output, /◆  WARNING/);
  assert.match(output, /╭/);
  assert.doesNotMatch(output, /\u001B\[/);
});

test("presentation summarizes severity counts and distinct review topics", () => {
  const sample = sampleReviewResult();
  const result: ReviewResult = {
    ...sample,
    findings: [
      ...sample.findings,
      {
        severity: "warning",
        category: "configuration",
        title: "Configuration file deleted",
        description: "A configuration file was deleted.",
        files: ["config/legacy.json"],
      },
      {
        severity: "info",
        category: "dependency",
        title: "Dependency configuration changed",
        description: "A dependency manifest changed.",
        files: ["package-lock.json"],
      },
    ],
  };

  const output = formatReview(result, { interactive: false, color: false, width: 88 });

  assert.match(output, /4 findings · 1 HIGH · 2 WARNINGS · 1 INFO/);
  assert.match(output, /1 HIGH · 2 WARNINGS · 1 INFO · Risk HIGH \(9\)/);
  assert.doesNotMatch(output, /\/10/);
  assert.doesNotMatch(output, /Review the highlighted findings and affected files\./);
  assert.equal((output.match(/→ Configuration changes/g) ?? []).length, 1);
  assert.match(output, /→ Database migration/);
  assert.match(output, /→ Dependency changes/);

  const pluralResult: ReviewResult = {
    ...result,
    findings: [
      ...result.findings,
      {
        severity: "high",
        category: "secret",
        title: "Possible secret",
        description: "A possible secret was introduced.",
        files: [".env"],
      },
      {
        severity: "info",
        category: "large-change",
        title: "Large change detected",
        description: "A large change was detected.",
        files: ["src/large.ts"],
      },
    ],
  };
  const pluralOutput = formatReview(pluralResult, { interactive: false, color: false, width: 88 });

  assert.match(pluralOutput, /6 findings · 2 HIGHS · 2 WARNINGS · 2 INFOS/);
  assert.match(pluralOutput, /2 HIGHS · 2 WARNINGS · 2 INFOS · Risk HIGH \(9\)/);
});

test("presentation wraps descriptions and verdict boxes without splitting words on narrow terminals", () => {
  const description = "A substantial production-source change has no related changed test file. Verify that changed behavior remains covered and existing assertions were not weakened or removed unintentionally.";
  const result: ReviewResult = {
    ...sampleReviewResult(),
    findings: [{
      severity: "warning",
      category: "test-attention",
      title: "Tests may need review",
      description,
      files: ["packages/cli/src/run-cli.ts"],
      evidence: ["Production lines changed: 37", "Related test files changed: 0"],
    }],
    risk: { score: 1, level: "low", contributions: [{ points: 1, reason: "Tests may need review" }] },
    verdict: "REVIEW RECOMMENDED",
  };

  const output = formatReview(result, { interactive: true, color: false, width: 42 });
  const boxLines = output.split("\n").filter((line) => line.startsWith("╭") || line.startsWith("│") || line.startsWith("╰"));

  assert.ok(boxLines.every((line) => line.length <= 42));
  for (const word of description.split(" ")) assert.ok(output.includes(word));
  assert.match(output, /  A substantial production-source change/);
  assert.match(output, /    - Production lines changed: 37/);
});

test("presentation keeps zero-finding reviews concise", () => {
  const result: ReviewResult = {
    ...sampleReviewResult(),
    findings: [],
    risk: { score: 0, level: "low", contributions: [] },
    verdict: "LOOKS ROUTINE",
  };

  const output = formatReview(result, { interactive: false, color: false });

  assert.match(output, /No deterministic review findings\./);
  assert.match(output, /No findings · Risk LOW \(0\)/);
  assert.match(output, /Review the diff normally before committing\./);
  assert.doesNotMatch(output, /Review before commit:/);

  const interactiveOutput = formatReview(result, { interactive: true, color: false });
  assert.match(interactiveOutput, /✓  LOOKS ROUTINE/);
});
test("non-interactive progress emits no transient terminal control sequences", () => {
  const writes: string[] = [];
  const progress = createProgress(
    { isTTY: false, write(message: string): boolean { writes.push(message); return true; } },
    "Analyzing repository...",
    { interactive: false, color: false },
  );

  progress.stop();
  assert.deepEqual(writes, []);
});

function sampleReviewResult(): ReviewResult {
  return {
    changes: { files: [
      { type: "modified", path: "src/service.ts" },
      { type: "created", path: "Migrations/20260819_AddOrderIndex.cs" },
      { type: "deleted", path: "src/legacy.ts" },
      { type: "renamed", previousPath: "src/old.ts", path: "src/new.ts" },
    ] },
    findings: [
      {
        severity: "high",
        category: "database",
        title: "Database migration added",
        description: "A migration-related file was added. Review schema changes.",
        files: ["Migrations/20260819_AddOrderIndex.cs"],
      },
      {
        severity: "warning",
        category: "configuration",
        title: "Configuration changed",
        description: "A configuration file changed.",
        files: ["appsettings.json"],
      },
    ],
    risk: { score: 9, level: "high", contributions: [{ points: 5, reason: "Database migration" }] },
    verdict: "CAREFUL REVIEW RECOMMENDED",
    checkpoint: { schemaVersion: 1, createdAt: "2026-08-27T00:00:00.000Z", head: "1234567890", branch: "main", tree: "tree" },
    current: { head: "1234567890", branch: "main", tree: "tree" },
    headChanged: false,
    branchChanged: false,
    content: { async readBefore(): Promise<Buffer | null> { return null; }, async readAfter(): Promise<Buffer | null> { return null; } },
  };
}

function agentcheck(cwd: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliEntry, ...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({
        exitCode: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function createRepository(files: Record<string, string>): Promise<TestRepository> {
  const path = await mkdtemp(join(tmpdir(), "agentcheck-cli-test-"));
  await git(path, ["init", "--initial-branch=main", "--quiet"]);
  await git(path, ["config", "user.name", "AgentCheck Test"]);
  await git(path, ["config", "user.email", "agentcheck@example.invalid"]);

  for (const [file, content] of Object.entries(files)) {
    await write(path, file, content);
  }

  await git(path, ["add", "-A", "--", "."]);
  await git(path, ["commit", "-m", "initial", "--quiet"]);
  return { path, cleanup: () => rm(path, { force: true, recursive: true }) };
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

function lines(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} line ${index}`).join("\n")}\n`;
}
