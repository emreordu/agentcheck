import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeChanges,
  ConfigurationAnalyzer,
  DangerousFileAnalyzer,
  DependencyAnalyzer,
  LARGE_CHANGE_THRESHOLDS,
  LargeChangeAnalyzer,
  MigrationAnalyzer,
  type AnalysisContext,
  type Analyzer,
  type FileChange,
  type Finding,
} from "./index.ts";

test("MigrationAnalyzer detects added and modified migration conventions only", async () => {
  const findings = await new MigrationAnalyzer().analyze(context([
    changed("created", "src/Migrations/20260819_AddOrder.cs"),
    changed("modified", "db/migration/V12__add_index.sql"),
    changed("modified", "prisma/schema.prisma"),
    changed("modified", "src/OrderService.ts"),
  ]));

  assert.deepEqual(findings.map(({ severity, title, files }) => ({ severity, title, files })), [
    { severity: "high", title: "Database migration added", files: ["src/Migrations/20260819_AddOrder.cs"] },
    { severity: "high", title: "Database migration changed", files: ["db/migration/V12__add_index.sql"] },
    { severity: "high", title: "Database migration changed", files: ["prisma/schema.prisma"] },
  ]);
});

test("MigrationAnalyzer detects migration-oriented SQL filenames without classifying ordinary SQL", async () => {
  const findings = await new MigrationAnalyzer().analyze(context([
    changed("created", "Fake_Migration_2026-08-26.sql"),
    changed("created", "packages/core/Fake_Migration_2026-08-26.sql"),
    changed("created", "packages/core/src/AddCustomerMigration.sql"),
    changed("created", "database-migration.sql"),
    changed("created", "migrate-users.sql"),
    changed("created", "report.sql"),
    changed("created", "customer_query.sql"),
    changed("created", "seed-data.sql"),
    changed("created", "stored-procedures.sql"),
    changed("created", "cleanup.sql"),
    changed("created", "notes/migration-plan.md"),
  ]));

  assert.deepEqual(findings.map((finding) => finding.files[0]), [
    "Fake_Migration_2026-08-26.sql",
    "packages/core/Fake_Migration_2026-08-26.sql",
    "packages/core/src/AddCustomerMigration.sql",
    "database-migration.sql",
    "migrate-users.sql",
  ]);
});
test("ConfigurationAnalyzer recognizes supported configuration paths with deterministic severity", async () => {
  const findings = await new ConfigurationAnalyzer().analyze(context([
    changed("modified", "appsettings.json"),
    changed("modified", "config/appsettings.Production.json"),
    changed("created", ".env"),
    changed("modified", "Dockerfile"),
    changed("deleted", "terraform/main.tf"),
    changed("modified", "src/main.ts"),
  ]));

  assert.deepEqual(findings.map(({ severity, title, files }) => ({ severity, title, files })), [
    { severity: "warning", title: "Configuration changed", files: ["appsettings.json"] },
    { severity: "warning", title: "Production configuration changed", files: ["config/appsettings.Production.json"] },
    { severity: "warning", title: "Configuration changed", files: [".env"] },
    { severity: "warning", title: "Configuration changed", files: ["Dockerfile"] },
    { severity: "high", title: "Configuration file deleted", files: ["terraform/main.tf"] },
  ]);
});

test("DangerousFileAnalyzer reports Git and CI control changes and important deletion", async () => {
  const findings = await new DangerousFileAnalyzer().analyze(context([
    changed("modified", ".gitignore"),
    changed("modified", ".github/workflows/ci.yml"),
    changed("deleted", "Jenkinsfile"),
    changed("modified", "Dockerfile"),
    changed("modified", "src/main.ts"),
  ]));

  assert.deepEqual(findings.map(({ severity, title, files }) => ({ severity, title, files })), [
    { severity: "warning", title: "Git ignore rules changed", files: [".gitignore"] },
    { severity: "warning", title: "CI/CD configuration changed", files: [".github/workflows/ci.yml"] },
    { severity: "high", title: "CI/CD file deleted", files: ["Jenkinsfile"] },
  ]);
});

test("DependencyAnalyzer finds package.json additions but not removals or version changes", async () => {
  const before = JSON.stringify({
    dependencies: { existing: "1.0.0", removed: "1.0.0" },
    devDependencies: { oldDev: "1.0.0" },
  });
  const after = JSON.stringify({
    dependencies: { existing: "2.0.0", added: "1.0.0" },
    devDependencies: { oldDev: "1.0.0", newDev: "1.0.0" },
  }, null, 2);

  const findings = await new DependencyAnalyzer().analyze(context(
    [changed("modified", "package.json")],
    { "package.json": before },
    { "package.json": after },
  ));

  assert.deepEqual(findings.map((finding) => finding.evidence?.[0]), [
    "Dependency: added",
    "Dependency: newDev",
  ]);
  assert.ok(findings.every(({ title }) => title === "Dependency added"));

  const formattingOnly = await new DependencyAnalyzer().analyze(context(
    [changed("modified", "package.json")],
    { "package.json": "{\"dependencies\":{\"same\":\"1\"}}" },
    { "package.json": "{\n  \"dependencies\": { \"same\": \"2\" }\n}\n" },
  ));
  assert.deepEqual(formattingOnly, []);
});

test("DependencyAnalyzer handles invalid package.json without failing the review", async () => {
  const findings = await new DependencyAnalyzer().analyze(context(
    [changed("modified", "package.json")],
    { "package.json": "{\"dependencies\":{}}" },
    { "package.json": "{ invalid" },
  ));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Dependency configuration changed");
  assert.match(findings[0]?.description ?? "", /could not be compared semantically/);
});

test("DependencyAnalyzer compares csproj and Directory.Packages.props Include items", async () => {
  const analyzer = new DependencyAnalyzer();
  const csproj = await analyzer.analyze(context(
    [changed("modified", "src/App.csproj")],
    { "src/App.csproj": "<Project><ItemGroup><PackageReference Include=\"Existing\" Version=\"1\" /></ItemGroup></Project>" },
    { "src/App.csproj": "<Project><ItemGroup><!-- <PackageReference Include=\"Commented\" /> --><PackageReference Version=\"1\" Include=\"Existing\" /><PackageReference Include=\"Polly\" Version=\"8\" /></ItemGroup></Project>" },
  ));
  assert.deepEqual(csproj.map((finding) => finding.evidence?.[0]), ["Dependency: Polly"]);

  const unchanged = await analyzer.analyze(context(
    [changed("modified", "src/App.csproj")],
    { "src/App.csproj": "<PackageReference Include='Same' Version='1'/>" },
    { "src/App.csproj": "\n<PackageReference Version='2' Include='Same' />\n" },
  ));
  assert.deepEqual(unchanged, []);

  const removed = await analyzer.analyze(context(
    [changed("modified", "src/App.csproj")],
    { "src/App.csproj": "<Project><PackageReference Include='Same'/><PackageReference Include='Removed'/></Project>" },
    { "src/App.csproj": "<Project><PackageReference Include='Same'/></Project>" },
  ));
  assert.deepEqual(removed, []);

  const central = await analyzer.analyze(context(
    [changed("modified", "Directory.Packages.props")],
    { "Directory.Packages.props": "<Project />" },
    { "Directory.Packages.props": "<Project><PackageVersion Include=\"Serilog\" Version=\"4\" /></Project>" },
  ));
  assert.equal(central[0]?.evidence?.[0], "Dependency: Serilog");
});

test("DependencyAnalyzer compares requirements by normalized package identity", async () => {
  const analyzer = new DependencyAnalyzer();
  const findings = await analyzer.analyze(context(
    [changed("modified", "requirements.txt")],
    { "requirements.txt": "requests==2.31\nFlask_Cors==4\n" },
    { "requirements.txt": "# updated\nrequests==2.32\n\nflask-cors==5\nhttpx>=0.27 # new\n" },
  ));
  assert.deepEqual(findings.map((finding) => finding.evidence?.[0]), ["Dependency: httpx"]);

  const commentsOnly = await analyzer.analyze(context(
    [changed("modified", "requirements.txt")],
    { "requirements.txt": "requests==1\n" },
    { "requirements.txt": "# comment\n\nrequests==2\n" },
  ));
  assert.deepEqual(commentsOnly, []);
});

test("DependencyAnalyzer emits a generic finding for unsupported manifests", async () => {
  const findings = await new DependencyAnalyzer().analyze(context([
    changed("modified", "pom.xml"),
    changed("modified", "src/main.ts"),
  ]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Dependency configuration changed");
  assert.match(findings[0]?.evidence?.[0] ?? "", /No semantic parser/);
});

test("LargeChangeAnalyzer applies file-count threshold and boundary deterministically", async () => {
  const analyzer = new LargeChangeAnalyzer();
  const below = Array.from(
    { length: LARGE_CHANGE_THRESHOLDS.changedFiles - 1 },
    (_, index) => changed("modified", `src/${index}.ts`),
  );
  assert.deepEqual(await analyzer.analyze(context(below)), []);

  const boundary = [...below, changed("modified", "src/boundary.ts")];
  const findings = await analyzer.analyze(context(boundary));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Large change set");
  assert.match(findings[0]?.description ?? "", /^50 files changed/);
});

test("LargeChangeAnalyzer reports files at the byte threshold but not below it", async () => {
  const analyzer = new LargeChangeAnalyzer();
  const belowPath = "assets/below.bin";
  const boundaryPath = "assets/boundary.bin";
  const findings = await analyzer.analyze(context(
    [changed("created", belowPath), changed("created", boundaryPath)],
    {},
    {
      [belowPath]: Buffer.alloc(LARGE_CHANGE_THRESHOLDS.largeFileBytes - 1),
      [boundaryPath]: Buffer.alloc(LARGE_CHANGE_THRESHOLDS.largeFileBytes),
    },
  ));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Large file added");
  assert.deepEqual(findings[0]?.files, [boundaryPath]);
});

test("analyzeChanges caches content reads and sorts findings deterministically", async () => {
  let reads = 0;
  const sharedFinding = (severity: Finding["severity"], category: Finding["category"], title: string): Finding => ({
    severity,
    category,
    title,
    description: title,
    files: ["file.ts"],
  });
  const analyzers: Analyzer[] = [
    analyzer("second", async (analysis) => {
      await analysis.files.readAfter("file.ts");
      return [sharedFinding("warning", "dependency", "B")];
    }),
    analyzer("first", async (analysis) => {
      await analysis.files.readAfter("file.ts");
      return [
        sharedFinding("high", "database", "Z"),
        sharedFinding("warning", "configuration", "A"),
      ];
    }),
  ];
  const analysisContext = context([changed("modified", "file.ts")], {}, { "file.ts": "after" });
  analysisContext.files.readAfter = async () => {
    reads += 1;
    return Buffer.from("after");
  };

  const findings = await analyzeChanges(analysisContext, analyzers);
  assert.equal(reads, 1);
  assert.deepEqual(findings.map(({ severity, category, title }) => ({ severity, category, title })), [
    { severity: "high", category: "database", title: "Z" },
    { severity: "warning", category: "configuration", title: "A" },
    { severity: "warning", category: "dependency", title: "B" },
  ]);
});

test("finding descriptions give bounded review direction", async () => {
  const configuration = await new ConfigurationAnalyzer().analyze(context([
    changed("modified", ".env"),
    changed("deleted", "terraform/main.tf"),
  ]));
  assert.match(configuration[0]?.description ?? "", /environment-specific values, credentials, URLs, feature flags/);
  assert.match(configuration[1]?.description ?? "", /Confirm that runtime, deployment, or automation settings/);

  const migration = await new MigrationAnalyzer().analyze(context([
    changed("created", "Migrations/20260825_AddOrders.sql"),
  ]));
  assert.match(migration[0]?.description ?? "", /schema changes, destructive operations, data transformations, and rollback implications/);
});

function analyzer(name: string, analyze: Analyzer["analyze"]): Analyzer {
  return { name, analyze };
}

function changed(type: FileChange["type"], path: string, previousPath?: string): FileChange {
  return previousPath === undefined ? { type, path } : { type, path, previousPath };
}

function context(
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
