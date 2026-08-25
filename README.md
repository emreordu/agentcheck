# AgentCheck

> Your coding agent says it's done. AgentCheck tells you what changed and what deserves your attention before you commit.

Deterministic, local-first verification of coding-agent changes before you commit.

Available as the [`@agentcheck/cli` npm package](https://www.npmjs.com/package/@agentcheck/cli), the [`@agentcheck/core` npm package](https://www.npmjs.com/package/@agentcheck/core), and the [AgentCheck extension on the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agentcheck.agentcheck-vscode).

AgentCheck standardizes the manual review loop that usually follows an agent's “done” message:

```text
coding agent → "done" → git status/diff, dependencies, migrations,
configuration, tests and secrets → developer review → commit
```

It creates a Git-backed checkpoint, compares that checkpoint with the current repository state, and reports deterministic findings, a transparent risk score, and a restrained verdict.

## How it works

```text
agentcheck start → coding agent → agentcheck → review → commit
```

AgentCheck preserves the real Git index. Each checkpoint baseline represents `HEAD` plus the Git-visible working-tree state at that moment: pre-existing staged and unstaged tracked changes, tracked deletions, and non-ignored untracked files. See [SEMANTICS.md](SEMANTICS.md) for the exact model.

## Installation

AgentCheck requires Node.js 22 or newer. Install the command-line product globally:

```bash
npm install -g @agentcheck/cli
```

The npm package is named `@agentcheck/cli`; the executable it installs is intentionally named `agentcheck`.

## CLI usage

```bash
agentcheck start

# run your coding agent

# review changes since the checkpoint
agentcheck

agentcheck clear
```

`agentcheck check` is an explicit alias for the argumentless review command.

Example output, abbreviated from the current CLI format:

```text
AgentCheck

Changes
────────────────────────────
1 modified
2 created
0 deleted
0 renamed

M  appsettings.Production.json
A  Migrations/20260819_AddOrderIndex.cs
A  src/OrderService.test.ts

Findings
────────────────────────────

HIGH
Database migration added
A migration-related file was added. Review schema changes, destructive operations, data transformations, and rollback implications.
Migrations/20260819_AddOrderIndex.cs

WARNING
Production configuration changed
Production runtime configuration was modified. Review the diff for environment-specific values, credentials, URLs, feature flags, or behavior changes.
appsettings.Production.json

Risk
────────────────────────────
+5 Database migration
+4 Production configuration

Score: 9 — HIGH
Based on 2 distinct risk signals; changed-file counts are shown separately.

Verdict
────────────────────────────
CAREFUL REVIEW RECOMMENDED
One or more high-severity findings require careful inspection before commit.
Review the highlighted findings and affected files.
```

### Finding message guidelines

Analyzer messages distinguish observed facts from review guidance:

- **Title:** a short, specific noun/action phrase, such as `Database migration added`.
- **Description:** why the deterministic signal may matter and, when useful, what to inspect.
- **Evidence:** only facts AgentCheck observed, such as a change type, manifest section, or detected signal; it does not contain interpretation or secret values.

Messages use neutral language such as “may change” when AgentCheck cannot determine the semantic impact.

## What it checks

The v0.1 analyzers flag migration-related files; recognized configuration files; Git ignore, Git attributes, and selected CI/CD files; dependency additions in supported manifests and changes to selected other dependency manifests; unusually large change sets or added files; newly introduced high-confidence secret indicators; and substantial production-source changes without related changed tests. Findings are evidence-based; they do not claim that a migration will run, a secret is valid, or test coverage is absent.

## VS Code

Install AgentCheck directly from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agentcheck.agentcheck-vscode). The extension ID is `agentcheck.agentcheck-vscode`.

The thin extension uses the same `@agentcheck/core` workflow as the CLI. Its command palette provides Create Checkpoint, Review Changes, Show Findings, and Clear Checkpoint. The AgentCheck activity view shows changes, findings with details and evidence, risk, and verdict; file items open workspace files. The status bar shows an active checkpoint before review and the latest risk level afterward. Analysis is command-driven; the extension performs no startup scan or background monitoring.

## Core library

`@agentcheck/core` is the programmatic engine behind the CLI and VS Code extension:

```bash
npm install @agentcheck/core
```

Most command-line users should install `@agentcheck/cli` instead. See the [`@agentcheck/core` package documentation](packages/core/README.md) for its exported API.

## Privacy

Analysis is performed locally. AgentCheck itself does not upload repository or source data.

AgentCheck v0.1 has no backend, account, login, cloud upload, LLM/API call, or telemetry. It invokes the local Git executable and stores checkpoint metadata in Git's repository metadata area.

## Limitations

- Ignored untracked files are not analyzed.
- Rename detection depends on Git's rename detection.
- Secret detection is a deliberately conservative heuristic and can miss unknown credential formats or report false positives. Secret values are not included in findings.
- Line comparison is not a semantic diff.
- Related-test analysis relies on naming and path heuristics. “No related tests changed” does not mean “there are no tests,” and test attention is not a coverage claim.
- Submodule contents are not analyzed recursively.
- Multi-root VS Code workspaces are not supported in v0.1.
- AgentCheck does not guarantee correctness or security; its output is input to developer review.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

The monorepo contains `packages/core` for all business logic, `packages/cli` for terminal presentation, and `packages/vscode` for the thin editor UI. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing analyzers.

## License

Apache License 2.0. See [LICENSE](LICENSE).
