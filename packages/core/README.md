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
## v0.2 review report contract

Core exposes `toReviewReport(result)` and `ReviewReport`: schema version `1` is a data-only, JSON-round-trippable review transport model. Finding and risk-contribution IDs are stable lowercase dotted identifiers; titles, descriptions, actions, and reasons remain presentation text and are not identity. Built-in findings always include a deterministic Core-authored `action`: the concise next inspection step.

A schema version describes the structure and semantics of the report, independently of checkpoint schema versioning. Version 1 is conservatively compatible only within its major schema version: additions are optional fields; removal, renaming, or semantic reinterpretation requires a new schema version.

Reports include checkpoint/current HEAD and branch context, change paths, findings, risk, and verdict. For each finding, `title` is the human label, `description` is the observed significance or rationale, `evidence` is deterministic supporting data, and `action` is the deterministic next inspection step. Dependency findings may additionally contain `dependencyDeltas`: literal `added`, `removed`, or `updated` records with normalized dependency names and safe before/after specifiers. They intentionally omit checkpoint timestamps and tree IDs (volatile/internal snapshot metadata), source content, Buffers, providers/functions, absolute local paths, Git process state, and secret values. Paths are repository-relative.

## Dependency deltas

Semantic literal deltas are supported for `package.json` dependency sections, `.csproj` `PackageReference` items with a `Version` attribute, `Directory.Packages.props` `PackageVersion` items with a `Version` attribute, and `requirements.txt` direct requirements. Package identity follows the existing parser rules: case-insensitive names for package.json and .NET, and normalized Python names for requirements files. Formatting-only edits and same-value section moves remain finding-free; whole semantic-manifest deletion remains bounded to the file-change report. Invalid, ambiguous, indirect, URL, editable, or property-driven forms do not fabricate version data and retain the conservative fallback behavior. AgentCheck reports literal evidence only: it does not resolve packages or make compatibility, safety, vulnerability, or upgrade recommendations.
