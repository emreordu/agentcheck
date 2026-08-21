# Contributing to AgentCheck

## Prerequisites

- Node.js 22 or newer
- npm
- Git available on `PATH`

## Install and verify

```bash
npm install
npm run typecheck
npm run build
npm test
```

Do not weaken tests or modify a developer's real Git index while testing checkpoint behavior.

## Repository structure

- `packages/core`: checkpoint semantics, Git integration, analyzers, risk, and verdict
- `packages/cli`: CLI argument handling and presentation
- `packages/vscode`: command-driven VS Code presentation over core
- `SEMANTICS.md`: source of truth for checkpoint behavior
- `AGENTS.md`: repository development constraints

## Changing analyzers

Keep analyzers deterministic, independently testable, and limited to changed files. Findings must explain what was observed without claiming more than the evidence supports. Add focused tests for positive, negative, malformed-input, and boundary cases. Secret findings must never contain matched values.

Do not duplicate analyzer or risk logic in CLI or VS Code. New production dependencies, public-contract changes, and checkpoint semantic changes require explicit maintainer approval.

## Pull request expectations

Keep changes scoped, describe observable behavior and limitations, and list the exact verification commands run. Include regression tests for confirmed bugs. Do not include generated build output, tarballs, VSIX files, credentials, or unrelated refactors.
