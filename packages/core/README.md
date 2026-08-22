# @agentcheck/core

The programmatic checkpoint, change-detection, analysis, risk, and verdict engine behind AgentCheck.

`@agentcheck/core` is local-first and deterministic. It provides the shared business logic used by the AgentCheck CLI and VS Code extension while preserving the developer's real Git index.

## Installation

Requires Node.js 22 or newer.

```bash
npm install @agentcheck/core
```

Developers looking for the normal command-line product should generally install `@agentcheck/cli` instead.

## Public API

The package root exports the following APIs.

Checkpoint workflow:

- `createCheckpoint(cwd?)`
- `loadCheckpoint(cwd?)`
- `createCurrentSnapshot(cwd?)`
- `reviewChanges(cwd?)`
- `clearCheckpoint(cwd?)`

Analysis and risk:

- `analyzeChanges(context, analyzers?)`
- `createCachedFileContentProvider(provider)`
- `defaultAnalyzers`
- `assessRisk(changes, findings)`
- `riskLevelForScore(score)`
- `verdictForRiskLevel(level)`
- `RISK_LEVEL_THRESHOLDS` and `RISK_WEIGHTS`

Individual analyzers and helpers:

- `ConfigurationAnalyzer`, `DangerousFileAnalyzer`, `DependencyAnalyzer`, `LargeChangeAnalyzer`, `MigrationAnalyzer`, `SecretAnalyzer`, and `TestChangeAnalyzer`
- `LARGE_CHANGE_THRESHOLDS`, `SECRET_PATTERNS`, `TEST_ATTENTION_THRESHOLDS`, and `isTestPath`
- `GitError` and `resolveRepository(cwd)`

Exported TypeScript types include `Checkpoint`, `Snapshot`, `ChangeSet`, `FileChange`, `ReviewResult`, `AnalysisContext`, `Analyzer`, `Finding`, `FileContentProvider`, `RiskAssessment`, `RiskLevel`, and `Verdict`, together with their related category and contribution types.

Example:

```ts
import { createCheckpoint, reviewChanges } from "@agentcheck/core";

await createCheckpoint(process.cwd());
const result = await reviewChanges(process.cwd());

console.log(result.changes.files);
console.log(result.findings);
console.log(result.risk);
console.log(result.verdict);
```

For checkpoint semantics, complete behavior, limitations, and source code, see the [AgentCheck repository](https://github.com/emreordu/agentcheck).
