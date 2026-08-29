import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewResult } from "@agentcheck/core";
import {
  CHECKPOINT_DIFF_MAX_TEXT_BYTES,
  CheckpointDiffReview,
  checkpointDiffTitle,
} from "./checkpoint-diff-model.ts";

test("returns exact snapshot text for modified, created, deleted, and renamed files", async () => {
  const review = new CheckpointDiffReview(sampleReview());

  await assertDiff(review, { type: "modified", path: "src/modified.ts" }, "before modified\n", "after modified\n");
  await assertDiff(review, { type: "created", path: "src/created.ts" }, "", "created\n");
  await assertDiff(review, { type: "deleted", path: "src/deleted.ts" }, "deleted\n", "");
  await assertDiff(
    review,
    { type: "renamed", previousPath: "src/old name.ts", path: "src/new name.ts" },
    "old content\n",
    "new content\n",
  );
});

test("only resolves change or path descriptors from the active review", () => {
  const review = new CheckpointDiffReview(sampleReview());

  assert.deepEqual(review.resolveChange({ path: "src/new name.ts" }), {
    type: "renamed",
    previousPath: "src/old name.ts",
    path: "src/new name.ts",
  });
  assert.deepEqual(review.resolveChange({ path: "src/old name.ts" }), {
    type: "renamed",
    previousPath: "src/old name.ts",
    path: "src/new name.ts",
  });
  assert.equal(review.resolveChange({ type: "modified", path: "../outside.ts" }), undefined);
  assert.equal(review.resolveChange({ type: "modified", path: "src/modified.ts", previousPath: "wrong.ts" }), undefined);
});

test("uses a deterministic opaque review identity and never puts content in document identity", () => {
  const result = sampleReview();
  const first = new CheckpointDiffReview(result);
  const second = new CheckpointDiffReview(result);
  const [before, after] = first.documentsFor({ type: "modified", path: "src/modified.ts" });

  assert.equal(first.id, second.id);
  assert.match(first.id, /^[a-f0-9]{16}$/);
  assert.deepEqual(before, { side: "checkpoint", path: "src/modified.ts" });
  assert.deepEqual(after, { side: "current", path: "src/modified.ts" });
  assert.doesNotMatch(JSON.stringify({ id: first.id, before, after }), /after modified|secret-value/);
  assert.equal(checkpointDiffTitle({ type: "renamed", previousPath: "old.ts", path: "new.ts" }), "AgentCheck: old.ts → new.ts — Checkpoint ↔ Current");
});

test("rejects binary, non-UTF-8, and oversized content without decoding it as text", async () => {
  const binary = new CheckpointDiffReview(sampleReview({ "src/created.ts": Buffer.from([1, 0, 2]) }));
  const invalidUtf8 = new CheckpointDiffReview(sampleReview({ "src/created.ts": Buffer.from([0xff]) }));
  const oversized = new CheckpointDiffReview(sampleReview({
    "src/created.ts": Buffer.alloc(CHECKPOINT_DIFF_MAX_TEXT_BYTES + 1, 65),
  }));

  const document = { side: "current" as const, path: "src/created.ts" };
  await assert.rejects(() => binary.readText(document), /binary/);
  await assert.rejects(() => invalidUtf8.readText(document), /valid UTF-8/);
  await assert.rejects(() => oversized.readText(document), /size limit/);
});

async function assertDiff(
  review: CheckpointDiffReview,
  change: { type: "modified" | "created" | "deleted" | "renamed"; path: string; previousPath?: string },
  expectedBefore: string,
  expectedAfter: string,
): Promise<void> {
  const resolved = review.resolveChange(change);
  assert.ok(resolved);
  const [before, after] = review.documentsFor(resolved);
  assert.equal(await review.readText(before), expectedBefore);
  assert.equal(await review.readText(after), expectedAfter);
}

function sampleReview(afterOverrides: Record<string, Buffer> = {}): ReviewResult {
  const before = new Map<string, Buffer>([
    ["src/modified.ts", Buffer.from("before modified\n")],
    ["src/deleted.ts", Buffer.from("deleted\n")],
    ["src/old name.ts", Buffer.from("old content\n")],
  ]);
  const after = new Map<string, Buffer>([
    ["src/modified.ts", Buffer.from("after modified\n")],
    ["src/created.ts", Buffer.from("created\n")],
    ["src/new name.ts", Buffer.from("new content\n")],
    ...Object.entries(afterOverrides),
  ]);
  return {
    changes: {
      files: [
        { type: "modified", path: "src/modified.ts" },
        { type: "created", path: "src/created.ts" },
        { type: "deleted", path: "src/deleted.ts" },
        { type: "renamed", previousPath: "src/old name.ts", path: "src/new name.ts" },
      ],
    },
    findings: [],
    risk: { score: 0, level: "low", contributions: [] },
    verdict: "LOOKS ROUTINE",
    checkpoint: { schemaVersion: 1, createdAt: "test", head: "before", branch: "main", tree: "before-tree" },
    current: { head: "after", branch: "main", tree: "after-tree" },
    headChanged: false,
    branchChanged: false,
    content: {
      async readBefore(path) { return before.get(path) ?? null; },
      async readAfter(path) { return after.get(path) ?? null; },
    },
  };
}
