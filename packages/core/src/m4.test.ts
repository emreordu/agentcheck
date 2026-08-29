import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRisk,
  FINDING_IDS,
  riskLevelForScore,
  SecretAnalyzer,
  TEST_ATTENTION_THRESHOLDS,
  TestChangeAnalyzer,
  verdictForRiskLevel,
  type AnalysisContext,
  type FileChange,
  type Finding,
} from "./index.ts";
import { verdictForReview } from "./risk.ts";

const FAKE_GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
const FAKE_AWS_KEY = "AKIA1234567890ABCDEF";
const FAKE_PASSWORD = "FakeStrongPass123!";
const FAKE_API_KEY = "FakeApiKeyValue123!";

test("SecretAnalyzer detects introduced high-confidence patterns without exposing values", async () => {
  const path = "config/credentials.txt";
  const after = [
    "-----BEGIN PRIVATE KEY-----",
    `github=${FAKE_GITHUB_TOKEN}`,
    `aws=${FAKE_AWS_KEY}`,
    `Server=localhost;Password=${FAKE_PASSWORD};Database=app`,
    `apiKey = \"${FAKE_API_KEY}\"`,
  ].join("\n");
  const findings = await new SecretAnalyzer().analyze(analysis(
    [changed("created", path)],
    {},
    { [path]: after },
  ));

  assert.equal(findings.length, 5);
  assert.ok(findings.every(({ severity, category, title }) =>
    severity === "high" && category === "secret" && title === "Possible secret"));
  const serialized = JSON.stringify(findings);
  assertSecretAbsent(serialized, FAKE_GITHUB_TOKEN);
  assertSecretAbsent(serialized, FAKE_AWS_KEY);
  assertSecretAbsent(serialized, FAKE_PASSWORD);
  assertSecretAbsent(serialized, FAKE_API_KEY);
  assert.ok(findings.every((finding) => finding.evidence?.includes("Matched value: ********")));
});

test("SecretAnalyzer ignores unchanged pre-checkpoint secrets and unrelated introduced lines", async () => {
  const path = "appsettings.json";
  const before = `Password=${FAKE_PASSWORD}\nMode=one\n`;
  const after = `Password=${FAKE_PASSWORD}\nMode=one\nTimeout=30\n`;
  const findings = await new SecretAnalyzer().analyze(analysis(
    [changed("modified", path)],
    { [path]: before },
    { [path]: after },
  ));
  assert.deepEqual(findings, []);
});

test("SecretAnalyzer rejects short, comment, example, placeholder, deleted, and binary signals", async () => {
  const findings = await new SecretAnalyzer().analyze(analysis(
    [
      changed("created", "short.txt"),
      changed("created", "comment.txt"),
      changed("created", "placeholder.txt"),
      changed("deleted", "deleted.txt"),
      changed("created", "binary.bin"),
    ],
    { "deleted.txt": `token = \"${FAKE_API_KEY}\"` },
    {
      "short.txt": "token = \"hello\"",
      "comment.txt": `// apiKey = \"${FAKE_API_KEY}\"`,
      "placeholder.txt": "password = \"replace-me-with-your-password\"\naws=AKIAIOSFODNN7EXAMPLE",
      "binary.bin": Buffer.concat([Buffer.from(`token = \"${FAKE_API_KEY}\"`), Buffer.from([0])]),
    },
  ));
  assert.deepEqual(findings, []);
});

test("SecretAnalyzer recognizes token assignments only when newly introduced", async () => {
  const path = "settings.ts";
  const fakeToken = "FakeTokenValue987654!";
  const findings = await new SecretAnalyzer().analyze(analysis(
    [changed("modified", path)],
    { [path]: "export const mode = 'dev';\n" },
    { [path]: `export const mode = 'dev';\nconst token = \"${fakeToken}\";\n` },
  ));
  assert.equal(findings.length, 1);
  assertSecretAbsent(JSON.stringify(findings), fakeToken);
  assertSecretAbsent(findings[0]?.action ?? "", fakeToken);
});

test("TestChangeAnalyzer reports substantial production changes without related changed tests", async () => {
  const path = "src/orders/OrderService.ts";
  const findings = await new TestChangeAnalyzer().analyze(analysis(
    [changed("modified", path)],
    { [path]: lines("before", 20) },
    { [path]: lines("after", 20) },
  ));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Tests may need review");
  assert.match(findings[0]?.description ?? "", /no related changed test file/i);
  assert.match(findings[0]?.description ?? "", /changed behavior remains covered/);
  assert.doesNotMatch(findings[0]?.description ?? "", /There are no tests|untested/i);
});

test("TestChangeAnalyzer accepts related created or renamed tests but not unrelated tests", async () => {
  const path = "src/orders/OrderService.ts";
  const content = {
    before: { [path]: lines("before", 20) },
    after: { [path]: lines("after", 20) },
  };
  const analyzer = new TestChangeAnalyzer();

  const createdRelated = await analyzer.analyze(analysis(
    [changed("modified", path), changed("created", "tests/orders/OrderService.test.ts")],
    content.before,
    { ...content.after, "tests/orders/OrderService.test.ts": "test\n" },
  ));
  assert.deepEqual(createdRelated, []);

  const renamedRelated = await analyzer.analyze(analysis(
    [
      changed("modified", path),
      changed("renamed", "tests/OrderService.integration.spec.ts", "tests/OrderService.spec.ts"),
    ],
    { ...content.before, "tests/OrderService.spec.ts": "test\n" },
    { ...content.after, "tests/OrderService.integration.spec.ts": "test\n" },
  ));
  assert.deepEqual(renamedRelated, []);

  const unrelated = await analyzer.analyze(analysis(
    [changed("modified", path), changed("modified", "tests/CustomerService.test.ts")],
    { ...content.before, "tests/CustomerService.test.ts": "old\n" },
    { ...content.after, "tests/CustomerService.test.ts": "new\n" },
  ));
  assert.equal(unrelated.length, 1);
});

test("TestChangeAnalyzer ignores small, config, migration, and documentation-only changes", async () => {
  const findings = await new TestChangeAnalyzer().analyze(analysis(
    [
      changed("modified", "src/small.ts"),
      changed("modified", "appsettings.json"),
      changed("created", "Migrations/AddOrder.cs"),
      changed("modified", "README.md"),
    ],
    { "src/small.ts": "const value = 1;\n" },
    {
      "src/small.ts": "const value = 2;\n",
      "appsettings.json": "{}",
      "Migrations/AddOrder.cs": lines("migration", 30),
      "README.md": "docs",
    },
  ));
  assert.deepEqual(findings, []);
});

test("TestChangeAnalyzer flags new anonymous API surface plus bootstrap wiring without related tests", async () => {
  const controller = "IKBox.API/Controllers/AgentCheckPublicProbeController.cs";
  const program = "IKBox.API/Program.cs";
  const findings = await new TestChangeAnalyzer().analyze(analysis(
    [changed("created", controller), changed("modified", program)],
    { [program]: "var app = builder.Build();\n" },
    {
      [controller]: "[AllowAnonymous]\npublic class AgentCheckPublicProbeController : ControllerBase {}\n",
      [program]: "var app = builder.Build();\napp.MapControllers();\n",
    },
  ));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Tests may need review");
  assert.deepEqual(findings[0]?.files, [controller, program]);
  assert.deepEqual(findings[0]?.evidence, [
    "New public production surface changed",
    "Application bootstrap runtime wiring changed",
    "Related test files changed: 0",
  ]);
});
test("TestChangeAnalyzer supports TypeScript, C#, Python, and Go related-test names", async () => {
  const cases = [
    ["src/OrderService.ts", "tests/OrderService.spec.ts"],
    ["src/OrderService.cs", "OrderServiceTests/OrderServiceTests.cs"],
    ["src/order_service.py", "tests/test_order_service.py"],
    ["src/order_service.go", "src/order_service_test.go"],
  ] as const;
  const analyzer = new TestChangeAnalyzer();

  for (const [production, relatedTest] of cases) {
    const findings = await analyzer.analyze(analysis(
      [changed("modified", production), changed("created", relatedTest)],
      { [production]: lines("before", 20) },
      { [production]: lines("after", 20), [relatedTest]: "test\n" },
    ));
    assert.deepEqual(findings, [], `${relatedTest} should be related to ${production}`);
  }
});

test("TestChangeAnalyzer recognizes narrow shared analyzer and CLI suites", async () => {
  const analyzer = new TestChangeAnalyzer();
  const cases = [
    ["packages/core/src/analyzers/migration-analyzer.ts", "packages/core/src/analyzer.test.ts"],
    ["packages/cli/src/presentation.ts", "packages/cli/src/cli.test.ts"],
  ] as const;
  for (const [production, relatedTest] of cases) {
    const findings = await analyzer.analyze(analysis(
      [changed("modified", production), changed("modified", relatedTest)],
      { [production]: lines("before", 20), [relatedTest]: "before\n" },
      { [production]: lines("after", 20), [relatedTest]: "after\n" },
    ));
    assert.deepEqual(findings, [], `${relatedTest} should cover the shared suite for ${production}`);
  }
});
test("TestChangeAnalyzer applies the production-file count threshold at its boundary", async () => {
  const changes = Array.from(
    { length: TEST_ATTENTION_THRESHOLDS.productionFiles },
    (_, index) => changed("modified", `src/file${index}.ts`),
  );
  const before = Object.fromEntries(changes.map(({ path }) => [path, "const value = 1;\n"]));
  const after = Object.fromEntries(changes.map(({ path }) => [path, "const value = 2;\n"]));
  const findings = await new TestChangeAnalyzer().analyze(analysis(changes, before, after));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]?.files, ["src/file0.ts", "src/file1.ts", "src/file2.ts"]);
});

test("risk assessment scores distinct signals once and maps verdicts deterministically", () => {
  const migration = finding("database", "Database migration added");
  const secret = finding("secret", "Possible secret");

  assert.deepEqual(assessRisk({ files: [] }, []), { score: 0, level: "low", contributions: [] });
  assert.equal(assessRisk({ files: [] }, [migration]).score, 5);
  assert.equal(assessRisk({ files: [] }, [migration]).level, "medium");
  assert.equal(assessRisk({ files: [] }, [secret]).score, 5);
  assert.deepEqual(assessRisk({ files: [] }, [migration, migration, secret]), {
    score: 10,
    level: "high",
    contributions: [
      { id: "database.migration", reason: "Database migration", points: 5 },
      { id: "security.possible-secret", reason: "Possible secret", points: 5 },
    ],
  });
  assert.equal(verdictForRiskLevel("low"), "LOOKS ROUTINE");
  assert.equal(verdictForRiskLevel("medium"), "REVIEW RECOMMENDED");
  assert.equal(verdictForRiskLevel("high"), "CAREFUL REVIEW RECOMMENDED");
});

test("review semantics keep findings, risk, and verdict consistent", () => {
  const routine = assessRisk({ files: [changed("modified", "src/OrderService.ts")] }, []);
  assert.deepEqual(routine, { score: 0, level: "low", contributions: [] });
  assert.equal(verdictForReview(routine.level, []), "LOOKS ROUTINE");

  const configuration = finding("configuration", "Configuration changed");
  const configurationRisk = assessRisk({ files: [] }, [configuration]);
  assert.deepEqual(configurationRisk, {
    score: 1,
    level: "low",
    contributions: [{ id: "configuration.changed", reason: "Configuration changed", points: 1 }],
  });
  assert.equal(verdictForReview(configurationRisk.level, [configuration]), "REVIEW RECOMMENDED");

  const duplicateConfigurationRisk = assessRisk(
    { files: [] },
    [configuration, configuration],
  );
  assert.deepEqual(duplicateConfigurationRisk, configurationRisk);

  const productionConfiguration = finding("configuration", "Production configuration changed");
  assert.deepEqual(assessRisk({ files: [] }, [configuration, productionConfiguration]), {
    score: 4,
    level: "medium",
    contributions: [{ id: "configuration.production-changed", reason: "Production configuration", points: 4 }],
  });
  const envConfiguration = { ...productionConfiguration, files: [".env.production"] };
  const envSensitive = { ...finding("sensitive-file", "Sensitive file changed"), files: [".env.production"] };
  assert.deepEqual(assessRisk({ files: [] }, [envConfiguration, envSensitive]), {
    score: 4,
    level: "medium",
    contributions: [{ id: "configuration.production-changed", reason: "Production configuration", points: 4 }],
  });
  assert.deepEqual(assessRisk(
    { files: [] },
    [{ ...finding("sensitive-file", "Sensitive file changed"), files: ["private.key"] }],
  ), {
    score: 2,
    level: "low",
    contributions: [{ id: "security.sensitive-file-changed", reason: "Sensitive file changed", points: 2 }],
  });

  const migration = { ...finding("database", "Database migration added"), severity: "high" as const };
  const highRisk = assessRisk(
    { files: [changed("deleted", "src/OldService.ts")] },
    [migration],
  );
  assert.deepEqual(highRisk, {
    score: 8,
    level: "high",
    contributions: [
      { id: "database.migration", reason: "Database migration", points: 5 },
      { id: "review.file-deleted", reason: "Deleted file", points: 3 },
    ],
  });
  assert.equal(verdictForReview(highRisk.level, [migration]), "CAREFUL REVIEW RECOMMENDED");
});

test("risk assessment does not inflate duplicate deletions or low-confidence dependency changes", () => {
  const changes = {
    files: [changed("deleted", "one.ts"), changed("deleted", "two.ts")],
  };
  const genericDependency = finding("dependency", "Dependency configuration changed");
  assert.deepEqual(assessRisk(changes, [genericDependency]), {
    score: 3,
    level: "medium",
    contributions: [{ id: "review.file-deleted", reason: "Deleted file", points: 3 }],
  });
});

test("risk assessment applies production config, dependency, CI, large-change, deletion, and test weights", () => {
  const assessment = assessRisk(
    { files: [changed("deleted", "old.ts")] },
    [
      finding("configuration", "Production configuration changed"),
      finding("dependency", "Dependency added"),
      finding("dangerous-file", "CI/CD configuration changed"),
      finding("large-change", "Large change set"),
      finding("test-attention", "Tests may need review"),
    ],
  );
  assert.deepEqual(assessment, {
    score: 15,
    level: "high",
    contributions: [
      { id: "configuration.production-changed", reason: "Production configuration", points: 4 },
      { id: "dependency.added", reason: "Dependency addition", points: 3 },
      { id: "review.file-deleted", reason: "Deleted file", points: 3 },
      { id: "delivery.ci-cd-changed", reason: "CI/CD change", points: 2 },
      { id: "review.large-change", reason: "Unusually large change", points: 2 },
      { id: "testing.coverage-review-needed", reason: "Tests may need review", points: 1 },
    ],
  });
});

test("risk level boundaries are 0-2 low, 3-6 medium, and 7+ high", () => {
  assert.equal(riskLevelForScore(2), "low");
  assert.equal(riskLevelForScore(3), "medium");
  assert.equal(riskLevelForScore(6), "medium");
  assert.equal(riskLevelForScore(7), "high");
});

function finding(category: Finding["category"], title: string): Finding {
  const id = title === "Production configuration changed" ? FINDING_IDS.productionConfigurationChanged : title === "Dependency added" ? FINDING_IDS.dependencyAdded : title === "CI/CD configuration changed" ? FINDING_IDS.ciCdConfigurationChanged : title === "Possible secret" ? FINDING_IDS.possibleSecret : title === "Database migration added" ? FINDING_IDS.databaseMigrationChanged : title === "Large change set" ? FINDING_IDS.largeChangeSet : title === "Tests may need review" ? FINDING_IDS.testsNeedReview : FINDING_IDS.configurationChanged;
  return { id, severity: "warning", category, title, description: title, action: "Review the finding.", files: [] };
}

function assertSecretAbsent(output: string, secret: string): void {
  if (output.includes(secret)) {
    assert.fail("A fake credential was exposed in a Finding object.");
  }
}

function changed(type: FileChange["type"], path: string, previousPath?: string): FileChange {
  return previousPath === undefined ? { type, path } : { type, path, previousPath };
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

function lines(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} line ${index}`).join("\n")}\n`;
}
