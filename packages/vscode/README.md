# AgentCheck for VS Code

> Verify what your coding agent actually changed before you commit.

AgentCheck provides deterministic post-agent verification. It creates a local Git-backed checkpoint, compares it with the current repository state, and shows what changed and what deserves attention.

Install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agentcheck.agentcheck-vscode). The extension ID is `agentcheck.agentcheck-vscode`.

## Workflow

1. Run **AgentCheck: Create Checkpoint** before the coding agent starts.
2. Run **AgentCheck: Review Changes** when the agent says it is done.
3. Inspect the Review view:
   - **CHANGES** — every changed file, including files without findings.
   - **FINDINGS** — deterministic attention signals with redacted evidence.
   - **RISK** — a transparent score and level.
   - **VERDICT** — a restrained review recommendation.
4. Select a changed or flagged file to open VS Code's native **Checkpoint ↔ Current** diff, then run **AgentCheck: Clear Checkpoint** when finished.

The left side is the AgentCheck checkpoint and the right side is the exact current snapshot used for that review. The checkpoint can include pre-existing staged or unstaged work, so it is not necessarily Git `HEAD`. Refresh the review before opening a diff if the file has changed again.

## Commands

- **AgentCheck: Create Checkpoint**
- **AgentCheck: Review Changes**
- **AgentCheck: Show Findings**
- **AgentCheck: Clear Checkpoint**
- **AgentCheck: Open Checkpoint Diff**

## CLI relationship and local operation

The extension is a thin VS Code interface over the same `@agentcheck/core` workflow used by the `agentcheck` CLI. It does not monitor or control the coding agent, replace Git or source control, or modify source files.

AgentCheck runs entirely locally. It has no backend, account, cloud upload, LLM or external API call, or telemetry. The extension is command-driven and performs no startup scan, file watching, or background analysis.

## v0.1 limitations

- One workspace folder is supported at a time.
- Ignored untracked files are not analyzed.
- Rename detection follows Git's behavior.
- Secret detection is conservative: it can produce false positives or miss unknown formats, and detected values are not displayed.
- Related-test findings are heuristic and do not measure test coverage.
- Submodule contents are not analyzed recursively.
- Findings do not guarantee correctness or security.

For CLI installation, complete behavior, and project documentation, see the [AgentCheck repository](https://github.com/emreordu/agentcheck).
