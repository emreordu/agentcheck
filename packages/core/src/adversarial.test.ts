import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeChanges,
  assessRisk,
  clearCheckpoint,
  createCheckpoint,
  reviewChanges,
  SecretAnalyzer,
  TEST_ATTENTION_THRESHOLDS,
  TestChangeAnalyzer,
  type AnalysisContext,
  type FileChange,
  type Finding,
} from "./index.ts";
import { verdictForReview } from "./risk.ts";

test("net-zero transitions and repeated reviews preserve a dirty baseline and repository state", async () => {
  const repository = await createRepository({
    "reverted.ts": "checkpoint content\n",
    "recreated.ts": "same content\n",
    "staged.ts": "committed\n",
  });
  try {
    await write(repository.path, "staged.ts", "staged baseline\n");
    await git(repository.path, ["add", "--", "staged.ts"]);
    await write(repository.path, "baseline-untracked.ts", "untracked baseline\n");
    const indexPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);
    const statusBefore = await git(repository.path, ["status", "--porcelain=v1", "-z"]);

    await createCheckpoint(repository.path);
    await write(repository.path, "reverted.ts", "temporary edit\n");
    await write(repository.path, "reverted.ts", "checkpoint content\n");
    await write(repository.path, "created-then-deleted.ts", "temporary\n");
    await rm(join(repository.path, "created-then-deleted.ts"));
    await rm(join(repository.path, "recreated.ts"));
    await write(repository.path, "recreated.ts", "same content\n");

    const first = await reviewChanges(repository.path);
    const second = await reviewChanges(repository.path);
    assert.deepEqual(first.changes.files, []);
    assert.deepEqual(first.findings, []);
    assert.deepEqual(first.risk, { score: 0, level: "low", contributions: [] });
    assert.equal(first.verdict, "LOOKS ROUTINE");
    assert.deepEqual(second.changes, first.changes);
    assert.deepEqual(second.findings, first.findings);
    assert.deepEqual(second.risk, first.risk);
    assert.equal(second.verdict, first.verdict);
    assert.deepEqual(await readFile(indexPath), indexBefore);
    assert.deepEqual(await git(repository.path, ["status", "--porcelain=v1", "-z"]), statusBefore);
    assert.equal(await readText(repository.path, "baseline-untracked.ts"), "untracked baseline\n");

    await clearCheckpoint(repository.path);
    await clearCheckpoint(repository.path);
    await assert.rejects(() => reviewChanges(repository.path), /No active/);
  } finally {
    await repository.cleanup();
  }
});

test("mixed post-checkpoint delta preserves the index and handles binary, CRLF, empty, deep, and Unicode paths", async () => {
  const sameBefore = numberedLines("committed", 20, "\n");
  const sameBaseline = numberedLines("developer", 20, "\n");
  const sameAfter = numberedLines("agent", 20, "\n");
  const repository = await createRepository({
    ".gitignore": "ignored/\n",
    "delete.ts": numberedLines("deleted", 20, "\n"),
    "line-ending.ts": numberedLines("line", 25, "\n"),
    "same.ts": sameBefore,
    "staged.ts": "committed\n",
    "unstaged.ts": "committed\n",
  });
  try {
    await write(repository.path, "staged.ts", "staged baseline\n");
    await git(repository.path, ["add", "--", "staged.ts"]);
    await write(repository.path, "unstaged.ts", "unstaged baseline\n");
    await write(repository.path, "baseline-untracked.ts", "untracked baseline\n");
    await write(repository.path, "same.ts", sameBaseline);
    const indexPath = await gitText(repository.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);

    await createCheckpoint(repository.path);
    assert.deepEqual(await readFile(indexPath), indexBefore);

    await write(repository.path, "same.ts", sameAfter);
    await rm(join(repository.path, "delete.ts"));
    await write(repository.path, "line-ending.ts", numberedLines("line", 25, "\r\n"));
    await write(repository.path, "deep/one/two/three/My Feature/ödeme-akışı.md", "docs\n");
    await write(repository.path, "empty.txt", "");
    await writeBuffer(repository.path, "assets/binary.bin", Buffer.from([0, 255, 1, 2, 3]));
    await write(repository.path, "ignored/output.txt", "ignored\n");

    const result = await reviewChanges(repository.path);
    const byPath = new Map(result.changes.files.map((change) => [change.path, change.type]));
    assert.equal(byPath.get("same.ts"), "modified");
    assert.equal(byPath.get("delete.ts"), "deleted");
    assert.equal(byPath.get("line-ending.ts"), "modified");
    assert.equal(byPath.get("deep/one/two/three/My Feature/ödeme-akışı.md"), "created");
    assert.equal(byPath.get("empty.txt"), "created");
    assert.equal(byPath.get("assets/binary.bin"), "created");
    assert.equal(byPath.has("staged.ts"), false);
    assert.equal(byPath.has("unstaged.ts"), false);
    assert.equal(byPath.has("baseline-untracked.ts"), false);
    assert.equal(byPath.has("ignored/output.txt"), false);
    assert.equal((await result.content.readBefore("same.ts"))?.toString(), sameBaseline);
    assert.equal((await result.content.readAfter("same.ts"))?.toString(), sameAfter);
    assert.equal(result.findings.some((finding) => finding.files.includes("assets/binary.bin")), false);
    assert.equal(result.findings.some((finding) => finding.files.includes("line-ending.ts")), false);
    assert.ok(result.findings.some((finding) => finding.title === "Tests may need review" && finding.files.includes("same.ts")));
    assert.ok(result.risk.contributions.some((contribution) => contribution.reason === "Deleted file"));
    assert.deepEqual(await readFile(indexPath), indexBefore);
  } finally {
    await repository.cleanup();
  }
});

test("test-attention line threshold is exact and line-ending-only changes are ignored", async () => {
  const analyzer = new TestChangeAnalyzer();
  const threshold = TEST_ATTENTION_THRESHOLDS.changedLinesPerFile;

  for (const [count, expected] of [
    [threshold - 1, 0],
    [threshold, 1],
    [threshold + 1, 1],
  ] as const) {
    const path = `src/created-${count}.ts`;
    const findings = await analyzer.analyze(analysis(
      [{ type: "created", path }],
      {},
      { [path]: numberedLines("created", count, "\n") },
    ));
    assert.equal(findings.length, expected, `${count} changed lines`);
  }

  const lineEndingPath = "src/line-ending.ts";
  assert.deepEqual(await analyzer.analyze(analysis(
    [{ type: "modified", path: lineEndingPath }],
    { [lineEndingPath]: numberedLines("same", threshold + 5, "\r\n") },
    { [lineEndingPath]: numberedLines("same", threshold + 5, "\n") },
  )), []);

  const renamedBefore = "src/OldOrderService.ts";
  const renamedAfter = "src/OrderService.ts";
  const shared = numberedLines("shared", 15, "\n");
  const renamedFindings = await analyzer.analyze(analysis(
    [{ type: "renamed", previousPath: renamedBefore, path: renamedAfter }],
    { [renamedBefore]: `${shared}${numberedLines("before", 10, "\n")}` },
    { [renamedAfter]: `${shared}${numberedLines("after", 10, "\n")}` },
  ));
  assert.equal(renamedFindings.length, 1);
  assert.deepEqual(renamedFindings[0]?.files, [renamedAfter]);
});

test("multiple risk categories remain deterministic, category-deduplicated, and verdict-consistent", async () => {
  const before = {
    "appsettings.Production.json": "{\"mode\":\"one\"}\n",
    "appsettings.json": "{\"mode\":\"one\"}\n",
    "package.json": "{\"dependencies\":{}}\n",
    "src/OldService.ts": numberedLines("old", 20, "\n"),
    "src/OrderService.ts": numberedLines("before", 20, "\n"),
  };
  const after = {
    "Migrations/20260819_AddOrderIndex.sql": "-- migration fixture\n",
    "appsettings.Production.json": "{\"mode\":\"two\"}\n",
    "appsettings.json": "{\"mode\":\"two\"}\n",
    "package.json": "{\"dependencies\":{\"example-package\":\"1.0.0\"}}\n",
    "src/OrderService.ts": numberedLines("after", 20, "\n"),
  };
  const changes: FileChange[] = [
    { type: "created", path: "Migrations/20260819_AddOrderIndex.sql" },
    { type: "modified", path: "appsettings.Production.json" },
    { type: "modified", path: "appsettings.json" },
    { type: "modified", path: "package.json" },
    { type: "deleted", path: "src/OldService.ts" },
    { type: "modified", path: "src/OrderService.ts" },
  ];
  const context = analysis(changes, before, after);
  const first = await analyzeChanges(context);
  const second = await analyzeChanges(context);
  assert.deepEqual(second, first);
  assert.equal(first.filter((finding) => finding.category === "configuration").length, 2);
  assert.ok(first.some((finding) => finding.title === "Database migration added"));
  assert.ok(first.some((finding) => finding.title === "Dependency added"));
  assert.ok(first.some((finding) => finding.title === "Tests may need review"));

  const risk = assessRisk({ files: changes }, first);
  assert.deepEqual(risk, {
    score: 16,
    level: "high",
    contributions: [
      { id: "database.migration", reason: "Database migration", points: 5 },
      { id: "configuration.production-changed", reason: "Production configuration", points: 4 },
      { id: "dependency.added", reason: "Dependency addition", points: 3 },
      { id: "review.file-deleted", reason: "Deleted file", points: 3 },
      { id: "testing.coverage-review-needed", reason: "Tests may need review", points: 1 },
    ],
  });
  assert.equal(verdictForReview(risk.level, first), "CAREFUL REVIEW RECOMMENDED");
});

test("routine docs, test, package-formatting, and small related source changes stay finding-free", async () => {
  const changes: FileChange[] = [
    { type: "modified", path: "README.md" },
    { type: "modified", path: "package.json" },
    { type: "modified", path: "src/OrderService.ts" },
    { type: "modified", path: "tests/OrderService.test.ts" },
  ];
  const findings = await analyzeChanges(analysis(
    changes,
    {
      "README.md": "before\n",
      "package.json": "{\"dependencies\":{\"same\":\"1\"}}\n",
      "src/OrderService.ts": "export const value = 1;\n",
      "tests/OrderService.test.ts": "test before\n",
    },
    {
      "README.md": "after\n",
      "package.json": "{\n  \"dependencies\": { \"same\": \"1\" }\n}\n",
      "src/OrderService.ts": "export const value = 2;\n",
      "tests/OrderService.test.ts": "test after\n",
    },
  ));
  assert.deepEqual(findings, []);
  const risk = assessRisk({ files: changes }, findings);
  assert.deepEqual(risk, { score: 0, level: "low", contributions: [] });
  assert.equal(verdictForReview(risk.level, findings), "LOOKS ROUTINE");
});

test("a deleted migration combines one database signal with one deletion contribution and a careful verdict", async () => {
  const path = "Migrations/20260819_AddOrderIndex.sql";
  const changes: FileChange[] = [{ type: "deleted", path }];
  const findings = await analyzeChanges(analysis(
    changes,
    { [path]: "-- migration fixture\n" },
    {},
  ));
  assert.equal(findings.filter((finding) => finding.category === "database").length, 1);
  const risk = assessRisk({ files: changes }, findings);
  assert.deepEqual(risk, {
    score: 8,
    level: "high",
    contributions: [
      { id: "database.migration", reason: "Database migration", points: 5 },
      { id: "review.file-deleted", reason: "Deleted file", points: 3 },
    ],
  });
  assert.equal(verdictForReview(risk.level, findings), "CAREFUL REVIEW RECOMMENDED");
});

test("a standalone high finding cannot produce a routine verdict even below the high score threshold", () => {
  const finding: Finding = {
    severity: "high",
    category: "database",
    title: "Database migration added",
    description: "A migration-related file was added. Review schema changes, destructive operations, data transformations, and rollback implications.",
    files: ["Migrations/Add.sql"],
  };
  const risk = assessRisk({ files: [] }, [finding]);
  assert.deepEqual(risk, {
    score: 5,
    level: "medium",
    contributions: [{ id: "database.migration", reason: "Database migration", points: 5 }],
  });
  assert.equal(verdictForReview(risk.level, [finding]), "CAREFUL REVIEW RECOMMENDED");
});

test("overlapping secret patterns produce one redacted finding for one introduced value", async () => {
  const path = "appsettings.Production.json";
  const fakeValue = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
  const findings = await new SecretAnalyzer().analyze(analysis(
    [{ type: "created", path }],
    {},
    { [path]: `{\"api_key\":\"${fakeValue}\"}\n` },
  ));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Possible secret");
  assert.equal(JSON.stringify(findings).includes(fakeValue), false);
});

interface TestRepository {
  path: string;
  cleanup(): Promise<void>;
}

async function createRepository(files: Record<string, string | Buffer>): Promise<TestRepository> {
  const path = await mkdtemp(join(tmpdir(), "agentcheck-adversarial-"));
  await git(path, ["init", "--initial-branch=main", "--quiet"]);
  await git(path, ["config", "core.autocrlf", "false"]);
  await git(path, ["config", "user.name", "AgentCheck Adversarial Test"]);
  await git(path, ["config", "user.email", "agentcheck@example.invalid"]);
  for (const [file, content] of Object.entries(files)) {
    await writeBuffer(path, file, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  await git(path, ["add", "-A", "--", "."]);
  await git(path, ["commit", "-m", "initial", "--quiet"]);
  return { path, cleanup: () => rm(path, { force: true, recursive: true }) };
}

function analysis(
  changes: FileChange[],
  before: Record<string, string | Buffer | null> = {},
  after: Record<string, string | Buffer | null> = {},
): AnalysisContext {
  return {
    checkpoint: {
      schemaVersion: 1,
      createdAt: "2026-08-19T00:00:00.000Z",
      head: "a".repeat(40),
      branch: "main",
      tree: "b".repeat(40),
    },
    changes: { files: changes },
    files: {
      readBefore: async (path) => toBuffer(before[path]),
      readAfter: async (path) => toBuffer(after[path]),
    },
  };
}

function toBuffer(value: string | Buffer | null | undefined): Buffer | null {
  if (value === undefined || value === null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function numberedLines(prefix: string, count: number, ending: "\n" | "\r\n"): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join(ending)}${ending}`;
}

async function write(repository: string, path: string, content: string): Promise<void> {
  await writeBuffer(repository, path, Buffer.from(content));
}

async function writeBuffer(repository: string, relativePath: string, content: Buffer): Promise<void> {
  const path = join(repository, ...relativePath.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function readText(repository: string, relativePath: string): Promise<string> {
  return readFile(join(repository, ...relativePath.split("/")), "utf8");
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
