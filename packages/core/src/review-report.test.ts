import assert from "node:assert/strict";
import test from "node:test";
import { actionForFinding, assessRisk, BUILT_IN_FINDING_ACTIONS, BUILT_IN_FINDING_IDS, BUILT_IN_RISK_CONTRIBUTION_IDS, FINDING_IDS, REVIEW_REPORT_SCHEMA_VERSION, toReviewReport, type Finding, type ReviewResult } from "./index.ts";

const finding: Finding = { id: FINDING_IDS.accessControlWeakened, severity: "high", category: "semantic-risk", title: "Presentation title", description: "Presentation description", action: "Presentation action", files: ["src/ü space.ts"], evidence: ["safe"] };
const result: ReviewResult = { changes: { files: [{ type: "renamed", previousPath: "old name.ts", path: "src/ü space.ts" }, { type: "deleted", path: "deleted file.ts" }] }, findings: [finding], risk: assessRisk({ files: [] }, [finding]), verdict: "CAREFUL REVIEW RECOMMENDED", checkpoint: { schemaVersion: 1, createdAt: "volatile", head: "before", branch: "main", tree: "tree-before" }, current: { head: "after", branch: "feature", tree: "tree-after" }, headChanged: true, branchChanged: true, content: { async readBefore() { return Buffer.from("secret-value"); }, async readAfter() { return null; } } };

test("stable ID registries are complete, unique, and conventionally named", () => {
  for (const ids of [BUILT_IN_FINDING_IDS, BUILT_IN_RISK_CONTRIBUTION_IDS]) {
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id)));
  }
  assert.ok(BUILT_IN_FINDING_IDS.length > 0 && BUILT_IN_RISK_CONTRIBUTION_IDS.length > 0);
});

test("built-in finding actions are complete, deterministic, and serializable", () => {
  assert.deepEqual(Object.keys(BUILT_IN_FINDING_ACTIONS).sort(), [...BUILT_IN_FINDING_IDS].sort());
  for (const id of BUILT_IN_FINDING_IDS) {
    const action = actionForFinding(id);
    assert.equal(action, BUILT_IN_FINDING_ACTIONS[id]);
    assert.ok(action.trim().length > 0);
    assert.equal(JSON.parse(JSON.stringify(action)), action);
  }
});
test("finding presentation and contribution reason do not drive risk identity", () => {
  const changed = { ...finding, title: "Changed title", description: "Changed description", action: "Changed action" };
  const first = assessRisk({ files: [] }, [finding]);
  const second = assessRisk({ files: [] }, [changed]);
  assert.deepEqual(second, first);
  assert.equal(first.contributions[0]?.id, "security.access-control-weakened");
  assert.equal(toReviewReport({ ...result, risk: { ...first, contributions: first.contributions.map((item) => ({ ...item, reason: "Changed reason" })) } }).risk.contributions[0]?.id, first.contributions[0]?.id);
});

test("ReviewReport is data-only, round-trippable, and omits volatile checkpoint internals", () => {
  const report = toReviewReport(result);
  assert.equal(report.schemaVersion, REVIEW_REPORT_SCHEMA_VERSION);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  const serialized = JSON.stringify(report);
  for (const forbidden of ["secret-value", "tree-before", "tree-after", "volatile", "readBefore", "C:\\\\"]) assert.ok(!serialized.includes(forbidden));
  assert.equal(report.changes.files[0]?.path, "src/ü space.ts");
  assert.equal(report.changes.files[0]?.previousPath, "old name.ts");
  assert.equal(report.context.checkpoint.head, "before");
  assert.equal(report.context.current.branch, "feature");
  assert.equal(report.findings[0]?.action, "Presentation action");
});
