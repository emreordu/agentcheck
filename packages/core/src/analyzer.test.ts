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
  SemanticRiskAnalyzer,
  assessRisk,
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

test("DependencyAnalyzer classifies representative generic manifests across ecosystems", async () => {
  const paths = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "packages.lock.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "pyproject.toml",
    "poetry.lock",
    "pubspec.lock",
  ];
  const findings = await new DependencyAnalyzer().analyze(context([
    ...paths.map((path) => changed("modified", path)),
    changed("modified", "src/main.ts"),
  ]));
  assert.deepEqual(findings.map((finding) => finding.files[0]), paths);
  assert.ok(findings.every((finding) => finding.title === "Dependency configuration changed"));
  assert.ok(findings.every((finding) => /No semantic parser/.test(finding.evidence?.[0] ?? "")));
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

test("SemanticRiskAnalyzer detects high-confidence security and runtime transitions without comment noise", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const accessPath = "Controllers/AdminController.cs";
  const accessFindings = await analyzer.analyze(context(
    [changed("modified", accessPath)],
    { [accessPath]: "[Authorize]\npublic class AdminController {}\n" },
    { [accessPath]: "[AllowAnonymous]\npublic class AdminController {}\n" },
  ));
  assert.deepEqual(accessFindings.map((finding) => finding.title), ["Access control weakened"]);
  assert.equal(accessFindings[0]?.severity, "high");
  assert.deepEqual(assessRisk({ files: [changed("modified", accessPath)] }, accessFindings), {
    score: 7,
    level: "high",
    contributions: [{ reason: "Access control weakened", points: 7 }],
  });

  const nodePath = "src/routes/admin.ts";
  assert.equal((await analyzer.analyze(context(
    [changed("modified", nodePath)],
    { [nodePath]: 'router.get("/admin", authMiddleware, handler);\n' },
    { [nodePath]: 'router.get("/admin", handler);\n' },
  )))[0]?.title, "Access control weakened");

  const disabledPath = "Program.cs";
  assert.ok((await analyzer.analyze(context(
    [changed("modified", disabledPath)],
    { [disabledPath]: "app.UseAuthorization();\n" },
    { [disabledPath]: "// app.UseAuthorization();\n" },
  ))).some((finding) => finding.title === "Security behavior disabled"));
  assert.deepEqual(await analyzer.analyze(context(
    [changed("modified", "src/log.ts")],
    { "src/log.ts": 'Console.WriteLine("debug");\n' },
    { "src/log.ts": '// Console.WriteLine("debug");\n' },
  )), []);
});

test("SemanticRiskAnalyzer detects HTTPS comment-out variants without comment noise", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const path = "Program.cs";
  for (const commentedCall of ["//app.UseHttpsRedirection();\n", "// app.UseHttpsRedirection();\n"]) {
    const findings = await analyzer.analyze(context(
      [changed("modified", path)],
      { [path]: "app.UseHttpsRedirection();\n" },
      { [path]: commentedCall },
    ));
    const finding = findings.find((candidate) => candidate.title === "Security behavior disabled");
    assert.equal(finding?.severity, "high");
    assert.ok(finding?.evidence?.includes("HTTPS redirection call commented out"));
    assert.equal(assessRisk({ files: [changed("modified", path)] }, findings).level, "high");
  }

  assert.deepEqual(await analyzer.analyze(context(
    [changed("modified", "src/log.ts")],
    { "src/log.ts": 'Console.WriteLine("debug");\n' },
    { "src/log.ts": '//Console.WriteLine("debug");\n' },
  )), []);
  assert.deepEqual(await analyzer.analyze(context(
    [changed("modified", path)],
    { [path]: "// documentation mentioning app.UseHttpsRedirection();\n" },
    { [path]: "// updated documentation mentioning app.UseHttpsRedirection();\n" },
  )), []);
});
test("SemanticRiskAnalyzer distinguishes public access, bootstrap wiring, disabled tests, and sensitive paths", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const publicPath = "Controllers/PublicController.cs";
  assert.equal((await analyzer.analyze(context(
    [changed("created", publicPath)],
    {},
    { [publicPath]: "[AllowAnonymous]\npublic class PublicController {}\n" },
  )))[0]?.title, "Anonymous access introduced");
  assert.deepEqual(await analyzer.analyze(context(
    [changed("created", "docs/access.md")],
    {},
    { "docs/access.md": "[AllowAnonymous] is supported.\n" },
  )), []);

  const bootstrapPath = "src/server.ts";
  assert.ok((await analyzer.analyze(context(
    [changed("modified", bootstrapPath)],
    { [bootstrapPath]: "const app = createApp();\n" },
    { [bootstrapPath]: "const app = createApp();\napp.use(authMiddleware);\n" },
  ))).some((finding) => finding.title === "Application bootstrap changed"));
  assert.deepEqual(await analyzer.analyze(context(
    [changed("modified", "main.py")],
    { "main.py": "# old note\n" },
    { "main.py": "# new note\n" },
  )), []);

  const testPath = "src/access.test.ts";
  assert.equal((await analyzer.analyze(context(
    [changed("modified", testPath)],
    { [testPath]: 'it("rejects anonymous", () => {});\n' },
    { [testPath]: 'it.skip("rejects anonymous", () => {});\n' },
  )))[0]?.title, "Tests may have been disabled");
  assert.equal((await analyzer.analyze(context(
    [changed("modified", "config/service-account.json")],
    { "config/service-account.json": "{}\n" },
    { "config/service-account.json": "{\"changed\":true}\n" },
  )))[0]?.title, "Sensitive file changed");
});
test("SemanticRiskAnalyzer covers deterministic access-control transitions across ecosystems", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const cases = [
    ["api/ProtectedView.py", "permission_classes = [IsAuthenticated]\n", "permission_classes = [AllowAny]\n"],
    ["src/AdminController.java", "@PreAuthorize(\"hasRole('ADMIN')\")\nvoid admin() {}\n", "void admin() {}\n"],
  ] as const;

  for (const [path, before, after] of cases) {
    const findings = await analyzer.analyze(context([changed("modified", path)], { [path]: before }, { [path]: after }));
    assert.equal(findings[0]?.title, "Access control weakened", path);
    assert.equal(findings[0]?.severity, "high", path);
  }

  const commentsOnly = await analyzer.analyze(context(
    [changed("modified", "api/ProtectedView.py")],
    { "api/ProtectedView.py": "# permission_classes = [IsAuthenticated]\n" },
    { "api/ProtectedView.py": "# permission_classes = [AllowAny]\n" },
  ));
  assert.deepEqual(commentsOnly, []);
  const stringsOnly = await analyzer.analyze(context(
    [changed("modified", "Controllers/AdminController.cs")],
    { "Controllers/AdminController.cs": 'const before = "[Authorize]";\n' },
    { "Controllers/AdminController.cs": 'const after = "[AllowAnonymous]";\n' },
  ));
  assert.deepEqual(stringsOnly, []);

  const newPublicRoute = await analyzer.analyze(context(
    [changed("created", "src/routes/public.ts")],
    {},
    { "src/routes/public.ts": 'router.get("/public", handler);\n' },
  ));
  assert.deepEqual(newPublicRoute, []);
});

test("SemanticRiskAnalyzer detects explicit test disables without comment or name noise", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const cases = [
    ["tests/access.test.ts", 'it("rejects access", () => {});\n', 'it.skip("rejects access", () => {});\n'],
    ["tests/access.spec.js", 'describe("access", () => {});\n', 'describe.skip("access", () => {});\n'],
    ["tests/test_access.py", "def test_access(): pass\n", "@pytest.mark.skip\ndef test_access(): pass\n"],
    ["src/AccessTest.java", "void access() {}\n", "@Disabled\nvoid access() {}\n"],
    ["src/AccessTests.cs", "[Fact]\nvoid Access() {}\n", "[Fact(Skip = \"temporary\")]\nvoid Access() {}\n"],
  ] as const;

  for (const [path, before, after] of cases) {
    const findings = await analyzer.analyze(context([changed("modified", path)], { [path]: before }, { [path]: after }));
    assert.equal(findings[0]?.title, "Tests may have been disabled", path);
  }

  const commentsAndNames = await analyzer.analyze(context(
    [changed("modified", "tests/access.test.ts")],
    { "tests/access.test.ts": 'it("access", () => {});\n' },
    { "tests/access.test.ts": '// pytest.mark.skip\nit("skip is part of the name", () => {});\nconst options = { skip: true };\n' },
  ));
  assert.deepEqual(commentsAndNames, []);
});

test("SemanticRiskAnalyzer recognizes Node, Python, and Flutter bootstrap wiring but not comments", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const cases = [
    ["server.js", "const app = createApp();\n", "const app = createApp();\napp.use(requestMiddleware);\n"],
    ["main.py", "app = create_app()\n", "app = create_app()\napp.add_middleware(SomeMiddleware)\n"],
    ["lib/main.dart", "void main() {}\n", "void main() { runApp(const App()); }\n"],
  ] as const;

  for (const [path, before, after] of cases) {
    const findings = await analyzer.analyze(context([changed("modified", path)], { [path]: before }, { [path]: after }));
    assert.ok(findings.some((finding) => finding.title === "Application bootstrap changed"), path);
  }

  const commentOnly = await analyzer.analyze(context(
    [changed("modified", "server.ts")],
    { "server.ts": "// old comment\n" },
    { "server.ts": "// harmless comment\n" },
  ));
  assert.deepEqual(commentOnly, []);
});

test("SemanticRiskAnalyzer recognizes Java entrypoint wiring only with executable diff evidence", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const springPath = "src/main/java/example/Application.java";
  const springBefore = [
    "@SpringBootApplication",
    "public class Application {",
    "  public static void main(String[] args) {",
    "    SpringApplication.run(Application.class, args);",
    "  }",
    "}",
  ].join("\n");
  const springAfter = springBefore.replace(
    "    SpringApplication.run",
    "    Runtime.getRuntime().addShutdownHook(new Thread(StartupTasks::close));\n    SpringApplication.run",
  );
  const springFindings = await analyzer.analyze(context(
    [changed("modified", springPath)],
    { [springPath]: springBefore },
    { [springPath]: springAfter },
  ));
  assert.deepEqual(springFindings.map((finding) => finding.title), ["Application bootstrap changed"]);

  const plainPath = "src/main/java/example/Main.java";
  const plainBefore = "public class Main { public static void main(String[] args) { System.out.println(args.length); } }\n";
  const plainAfter = "public class Main { public static void main(String[] args) { DesktopApplication.start(args); } }\n";
  assert.equal((await analyzer.analyze(context(
    [changed("modified", plainPath)],
    { [plainPath]: plainBefore },
    { [plainPath]: plainAfter },
  )))[0]?.title, "Application bootstrap changed");

  const commentOnly = springBefore.replace("@SpringBootApplication", "// old note\n@SpringBootApplication");
  const harmlessComment = springBefore.replace("@SpringBootApplication", "// harmless comment\n@SpringBootApplication");
  assert.deepEqual(await analyzer.analyze(context(
    [changed("modified", springPath)],
    { [springPath]: commentOnly },
    { [springPath]: harmlessComment },
  )), []);

  const servicePath = "src/main/java/example/OrderService.java";
  assert.deepEqual(await analyzer.analyze(context(
    [changed("modified", servicePath)],
    { [servicePath]: "class OrderService { void update() {} }\n" },
    { [servicePath]: "class OrderService { void update() { DesktopApplication.start(); } }\n" },
  )), []);
  assert.deepEqual(await analyzer.analyze(context(
    [changed("modified", "docs/spring.md")],
    { "docs/spring.md": "old docs\n" },
    { "docs/spring.md": "SpringApplication.run(Application.class, args) starts the service.\n" },
  )), []);
});

test("SemanticRiskAnalyzer covers Python web and CLI entrypoints without comments, strings, or module noise", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const webPath = "main.py";
  assert.equal((await analyzer.analyze(context(
    [changed("modified", webPath)],
    { [webPath]: "app = FastAPI()\n" },
    { [webPath]: "app = FastAPI()\napp.include_router(api_router)\n" },
  )))[0]?.title, "Application bootstrap changed");

  const cliPath = "tool/__main__.py";
  assert.equal((await analyzer.analyze(context(
    [changed("modified", cliPath)],
    { [cliPath]: "if __name__ == \"__main__\":\n    pass\n" },
    { [cliPath]: "if __name__ == \"__main__\":\n    CliApplication.start()\n" },
  )))[0]?.title, "Application bootstrap changed");

  const quietCases = [
    ["main.py", "# old note\n", "# harmless note\n"],
    ["main.py", "print(\"old\")\n", "print(\"uvicorn.run(app)\")\n"],
    ["src/formatter.py", "def format_value(value): return value\n", "def format_value(value): return value.strip()\n"],
    ["src/worker.py", "def run_job(): pass\n", "def run_job(): AppRuntime.start()\n"],
  ] as const;
  for (const [path, before, after] of quietCases) {
    assert.deepEqual(
      await analyzer.analyze(context([changed("modified", path)], { [path]: before }, { [path]: after })),
      [],
      path,
    );
  }
});

test("SemanticRiskAnalyzer covers Node, frontend, CLI, desktop, and mobile bootstrap roles with quiet ordinary source", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const cases = [
    ["server.ts", "const app = createApp();\n", "const app = createApp();\napp.use(runtimeMiddleware);\n"],
    ["server.js", "server.listen(3000);\n", "server.listen(runtimePort);\n"],
    ["cli.ts", "const program = createProgram();\n", "const program = createProgram();\nprogram.command(\"check\");\n"],
    ["tools/bin/agentcheck.ts", "const program = createProgram();\n", "const program = createProgram();\nprogram.parse();\n"],
    ["middleware.ts", "export function middleware() { return NextResponse.next(); }\n", "export function middleware() { return NextResponse.redirect(loginUrl); }\n"],
    ["desktop/main.ts", "const appName = \"Desktop\";\n", "const appName = \"Desktop\";\napp.whenReady();\n"],
    ["desktop/preload.ts", "const version = 1;\n", "const version = 1;\ncontextBridge.exposeInMainWorld(\"api\", api);\n"],
    ["desktop/Program.cs", "Console.WriteLine(\"starting\");\n", "Console.WriteLine(\"starting\");\nApplication.Run(new MainWindow());\n"],
    ["ios/Runner/AppDelegate.swift", "class AppDelegate {}\n", "class AppDelegate { registerForRemoteNotifications(); }\n"],
    ["lib/main.dart", "void main() {}\n", "void main() { runApp(const MobileApp()); }\n"],
  ] as const;
  for (const [path, before, after] of cases) {
    const findings = await analyzer.analyze(context([changed("modified", path)], { [path]: before }, { [path]: after }));
    assert.deepEqual(findings.map((finding) => finding.title), ["Application bootstrap changed"], path);
  }

  const quietCases = [
    ["server.ts", "/*\n * old comment\n */\n", "/*\n * app.use(...) is documentation\n */\n"],
    ["src/helper.ts", "export const value = 1;\n", "export const value = 2;\nserver.listen(3000);\n"],
    ["src/components/Button.tsx", "export const Button = () => <button />;\n", "export const Button = () => <button>Save</button>;\n"],
    ["src/UserCard.vue", "<template>User</template>\n", "<template>Updated user</template>\n"],
    ["src/HomePage.tsx", "export const HomePage = () => <main />;\n", "export const HomePage = () => <main>Home</main>;\n"],
    ["lib/widgets/home_widget.dart", "class HomeWidget {}\n", "class HomeWidget { final title = \"Home\"; }\n"],
  ] as const;
  for (const [path, before, after] of quietCases) {
    assert.deepEqual(
      await analyzer.analyze(context([changed("modified", path)], { [path]: before }, { [path]: after })),
      [],
      path,
    );
  }
});

test("SemanticRiskAnalyzer maps Dart test disable syntax to the generic finding without comment or string noise", async () => {
  const analyzer = new SemanticRiskAnalyzer();
  const path = "test/access_test.dart";
  const findings = await analyzer.analyze(context(
    [changed("modified", path)],
    { [path]: "test(\"rejects anonymous access\", () {});\n" },
    { [path]: "test(\"rejects anonymous access\", () {}, skip: true);\n" },
  ));
  assert.deepEqual(findings.map((finding) => finding.title), ["Tests may have been disabled"]);

  const quiet = await analyzer.analyze(context(
    [changed("modified", path)],
    { [path]: "print(\"old\");\n" },
    { [path]: "// skip: true\nprint(\"skip: true\");\n" },
  ));
  assert.deepEqual(quiet, []);
});

test("cross-platform path classifiers cover configuration, sensitive paths, frontend, mobile, and CI without substring noise", async () => {
  const configuration = await new ConfigurationAnalyzer().analyze(context([
    changed("modified", "appsettings.Production.json"),
    changed("modified", "application.yml"),
    changed("modified", "application.properties"),
    changed("modified", "settings.py"),
    changed("modified", "config.yaml"),
    changed("modified", "environment.prod.ts"),
    changed("modified", "next.config.ts"),
    changed("modified", "vite.config.ts"),
    changed("modified", "AndroidManifest.xml"),
    changed("modified", "res/xml/network_security_config.xml"),
    changed("modified", "Info.plist"),
    changed("modified", "Runner.entitlements"),
    changed("modified", "gradle.properties"),
    changed("modified", "pubspec.yaml"),
    changed("modified", "src/SettingsService.ts"),
    changed("modified", "src/ConfigurationParser.java"),
    changed("modified", "src/components/ConfigButton.tsx"),
    changed("modified", "src/settings-helper.py"),
  ]));
  assert.deepEqual(configuration.map((finding) => finding.files[0]), [
    "appsettings.Production.json", "application.yml", "application.properties", "settings.py", "config.yaml",
    "environment.prod.ts", "next.config.ts", "vite.config.ts", "AndroidManifest.xml",
    "res/xml/network_security_config.xml", "Info.plist", "Runner.entitlements", "gradle.properties", "pubspec.yaml",
  ]);

  const sensitivePaths = [
    ".env", ".env.production", "certs/private.key", "certs/certificate.pem", "config/credentials.json",
    "config/service-account.json", "config/secrets.yaml", ".npmrc", ".pypirc", "gradle.properties",
    "src/keyboard.ts", "src/monkey.py", "src/key-value-helper.ts", "src/credentials-view-model.ts",
    "src/secretary.ts", "src/components/Button.tsx",
  ];
  const sensitive = await new SemanticRiskAnalyzer().analyze(context(
    sensitivePaths.map((path) => changed("modified", path)),
    Object.fromEntries(sensitivePaths.map((path) => [path, "before\n"])),
    Object.fromEntries(sensitivePaths.map((path) => [path, "after\n"])),
  ));
  assert.deepEqual(sensitive.map((finding) => finding.files[0]), [
    ".env", ".env.production", "certs/private.key", "certs/certificate.pem", "config/credentials.json",
    "config/service-account.json", "config/secrets.yaml", ".npmrc", ".pypirc", "gradle.properties",
  ]);
  assert.ok(sensitive.every((finding) => finding.title === "Sensitive file changed"));

  const ci = await new DangerousFileAnalyzer().analyze(context([
    changed("modified", ".github/workflows/ci.yml"),
    changed("modified", "Jenkinsfile"),
    changed("modified", ".gitlab-ci.yml"),
    changed("modified", "azure-pipelines.yml"),
  ]));
  assert.ok(ci.every((finding) => finding.title === "CI/CD configuration changed"));
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
