# AgentCheck for VS Code

Independent, local change verification for AI-assisted coding.

Use the command palette to run:

- `AgentCheck: Create Checkpoint`
- `AgentCheck: Review Changes`
- `AgentCheck: Show Review`
- `AgentCheck: Clear Checkpoint`

The Review view shows every changed file, findings grouped by severity with their details and evidence, the risk score and level, and the verdict. The status bar shows when a checkpoint is active and displays the latest risk level after review. File items open only files inside the current workspace.

AgentCheck supports one workspace folder at a time in v0.1. It runs only on explicit commands: there are no startup scans, file watchers, cloud uploads, API calls, or telemetry. See the project README for checkpoint semantics and limitations.
