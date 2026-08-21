# AgentCheck for VS Code

Independent, local change verification for AI-assisted coding.

Use the command palette to run:

- `AgentCheck: Create Checkpoint`
- `AgentCheck: Review Changes`
- `AgentCheck: Show Findings`
- `AgentCheck: Clear Checkpoint`

The Findings view groups the latest deterministic findings by severity. The status bar displays the latest risk level. File items open only files inside the current workspace.

AgentCheck supports one workspace folder at a time in v0.1. It runs only on explicit commands: there are no startup scans, file watchers, cloud uploads, API calls, or telemetry. See the project README for checkpoint semantics and limitations.
