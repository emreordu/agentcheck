import assert from "node:assert/strict";
import test from "node:test";
import type { Finding } from "@agentcheck/core";
import {
  buildReviewTree,
  changeLabel,
  checkpointStatus,
  childrenOf,
  reviewStatus,
  type ReviewPresentation,
} from "./findings-tree.ts";

test("displays every changed file even when there are no findings", () => {
  const result = review({ findings: [] });
  const roots = buildReviewTree(result);

  assert.deepEqual(roots.map(({ section }) => section), ["changes", "findings", "risk", "verdict"]);
  const changes = childrenOf(roots[0]!);
  assert.equal(changes.length, 4);
  assert.deepEqual(changes.map((node) => node.kind === "change" ? changeLabel(node.change) : ""), [
    "M src/modified.ts",
    "A src/created.ts",
    "D src/deleted.ts",
    "R src/old.ts -> src/new.ts",
  ]);
  assert.deepEqual(childrenOf(roots[1]!), []);
});

test("represents finding files, why it matters, and evidence by severity", () => {
  const result = review({
    findings: [{
      ...finding("high", "Possible secret", ["appsettings.json"]),
      description: "Credentials can be exposed.",
      evidence: ["Matched value: ********", "Line 4"],
    }],
  });

  const findingsSection = buildReviewTree(result)[1]!;
  const severity = childrenOf(findingsSection)[0]!;
  assert.equal(severity.kind, "severity");
  const findingNode = childrenOf(severity)[0]!;
  assert.equal(findingNode.kind, "finding");
  const details = childrenOf(findingNode);
  assert.deepEqual(details.slice(0, 3), [
    { kind: "file", path: "appsettings.json" },
    { kind: "detail", label: "Why it matters", value: "Credentials can be exposed." },
    { kind: "detail", label: "Review", value: "Review Possible secret" },
  ]);
  const evidence = details[3]!;
  assert.equal(evidence.kind, "evidence-group");
  assert.deepEqual(childrenOf(evidence), [
    { kind: "evidence", value: "Matched value: ********" },
    { kind: "evidence", value: "Line 4" },
  ]);
  assert.doesNotMatch(JSON.stringify(buildReviewTree(result)), /FakeCredential/);
});

test("exposes Core dependency delta data and evidence without extension-side parsing", () => {
  const result = review({
    findings: [{
      ...finding("warning", "Dependency updated", ["package.json"]),
      dependencyDeltas: [{ kind: "updated", name: "library", previousVersion: "^1.0.0", currentVersion: "^1.1.0" }],
      evidence: ["Updated: library ^1.0.0 → ^1.1.0"],
    }],
  });

  const findingsSection = buildReviewTree(result)[1]!;
  const severity = childrenOf(findingsSection)[0]!;
  const findingNode = childrenOf(severity)[0]!;
  assert.equal(findingNode.kind, "finding");
  assert.deepEqual(findingNode.finding.dependencyDeltas, [{ kind: "updated", name: "library", previousVersion: "^1.0.0", currentVersion: "^1.1.0" }]);
  const evidence = childrenOf(findingNode).find((node) => node.kind === "evidence-group");
  assert.ok(evidence && evidence.kind === "evidence-group");
  assert.deepEqual(childrenOf(evidence), [{ kind: "evidence", value: "Updated: library ^1.0.0 → ^1.1.0" }]);
});
test("represents risk score, risk level, verdict, and review status", () => {
  const result = review({ risk: { score: 42, level: "medium", contributions: [] }, verdict: "REVIEW RECOMMENDED" });
  const roots = buildReviewTree(result);

  assert.deepEqual(childrenOf(roots[2]!), [
    { kind: "risk-value", label: "Score", value: "42" },
    { kind: "risk-value", label: "Level", value: "MEDIUM" },
  ]);
  assert.deepEqual(childrenOf(roots[3]!), [
    { kind: "verdict-value", value: "REVIEW RECOMMENDED" },
  ]);
  assert.match(reviewStatus("medium").text, /MEDIUM/);
});

test("checkpoint status clearly indicates an active checkpoint", () => {
  const status = checkpointStatus();
  assert.match(status.text, /AgentCheck: CHECKPOINT/);
  assert.match(status.tooltip, /checkpoint is active/i);
});

function review(overrides: Partial<ReviewPresentation> = {}): ReviewPresentation {
  return {
    changes: {
      files: [
        { type: "modified", path: "src/modified.ts" },
        { type: "created", path: "src/created.ts" },
        { type: "deleted", path: "src/deleted.ts" },
        { type: "renamed", previousPath: "src/old.ts", path: "src/new.ts" },
      ],
    },
    findings: [finding("warning", "Dependency added", ["package.json"])],
    risk: { score: 10, level: "low", contributions: [] },
    verdict: "LOOKS ROUTINE",
    ...overrides,
  };
}

function finding(severity: Finding["severity"], title: string, files: string[]): Finding {
  return { severity, category: "dependency", title, description: title, action: `Review ${title}`, files };
}
