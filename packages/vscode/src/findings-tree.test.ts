import assert from "node:assert/strict";
import test from "node:test";
import { buildFindingTree, childrenOf } from "./findings-tree.ts";
import type { Finding } from "@agentcheck/core";

test("groups findings by deterministic severity order without secret evidence", () => {
  const findings: Finding[] = [
    finding("warning", "Dependency added", ["package.json"]),
    {
      ...finding("high", "Possible secret", ["appsettings.json"]),
      evidence: ["Matched value: ********"],
    },
    finding("info", "Information", []),
  ];

  const groups = buildFindingTree(findings);
  assert.deepEqual(groups.map(({ severity }) => severity), ["high", "warning", "info"]);
  const secretNode = childrenOf(groups[0]!)[0]!;
  assert.equal(secretNode.kind, "finding");
  if (secretNode.kind === "finding") {
    assert.equal(secretNode.finding.title, "Possible secret");
    assert.deepEqual(childrenOf(secretNode), [{ kind: "file", path: "appsettings.json" }]);
  }
  assert.doesNotMatch(JSON.stringify(groups), /FakeCredential/);
});

function finding(severity: Finding["severity"], title: string, files: string[]): Finding {
  return { severity, category: "dependency", title, description: title, files };
}
