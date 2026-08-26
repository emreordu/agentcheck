# Security Policy

## Supported Versions

AgentCheck is currently under active development.

Security updates are generally applied to the latest released version.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅         |
| Older releases | ❌         |

Users are encouraged to keep AgentCheck up to date before reporting or investigating security-related issues.

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for suspected security vulnerabilities.

If you discover a security issue in AgentCheck, report it privately through GitHub's security reporting features when available:

**GitHub Repository → Security → Advisories → Report a vulnerability**

Repository:

https://github.com/emreordu/agentcheck

When reporting a vulnerability, please include as much relevant information as possible:

* A clear description of the issue
* Steps to reproduce it
* The affected AgentCheck version
* The affected component, such as Core, CLI, or VS Code extension
* Potential security impact
* Example inputs or repository state, if applicable
* Any suggested mitigation or fix, if known

Please avoid including real credentials, API keys, tokens, private source code, or other sensitive information in vulnerability reports.

## Security Principles

AgentCheck is designed as a **local-first verification tool**.

The project aims to follow these security principles:

* Repository analysis should remain local unless explicitly documented otherwise.
* AgentCheck should not intentionally transmit source code, repository contents, credentials, or findings to external services.
* Existing Git state, including staged changes, should not be modified unexpectedly.
* AgentCheck-generated data should be isolated from normal repository state where possible.
* Sensitive values detected during analysis should not be unnecessarily exposed in output.
* Security-related findings should be based on observable evidence rather than unsupported assumptions.

If behavior is discovered that violates these principles, it may qualify as a security issue.

## Examples of Security Issues

Examples of issues that should be reported privately include:

* Exposure of secrets or credentials through AgentCheck output
* Unexpected transmission of repository data
* Arbitrary command execution
* Path traversal or unintended file access
* Modification or corruption of Git repository state
* Unsafe handling of temporary files or snapshots
* Vulnerabilities in the CLI or VS Code extension that could execute untrusted content
* Dependency vulnerabilities that are directly exploitable through AgentCheck

General bugs, incorrect findings, feature requests, and false positives that do not create a security risk can be reported through normal GitHub issues.

## Disclosure

Please allow maintainers reasonable time to investigate and address a reported vulnerability before publicly disclosing technical details.

We appreciate responsible disclosure and contributions that help make AgentCheck safer for everyone.

## Scope

This policy applies to the official AgentCheck project and its maintained components, including:

* `@agentcheck/core`
* `@agentcheck/cli`
* AgentCheck VS Code extension
* Official AgentCheck repository code

Third-party integrations, forks, modified distributions, and unrelated dependencies may have their own security policies.
