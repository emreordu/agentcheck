import { compareLines, decodeText } from "../line-diff.ts";
import { FINDING_IDS } from "../stable-ids.ts";
import { actionForFinding } from "../finding-actions.ts";
import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

interface SecretPattern {
  id: string;
  label: string;
  pattern: RegExp;
  value(match: RegExpMatchArray): string;
  validateValue?: boolean;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "private-key",
    label: "Private key header",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    value: (match) => match[0],
  },
  {
    id: "github-token",
    label: "GitHub token format",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g,
    value: (match) => match[0],
  },
  {
    id: "aws-access-key",
    label: "AWS access key format",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    value: (match) => match[0],
  },
  {
    id: "stripe-live-key",
    label: "Stripe live key format",
    pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/g,
    value: (match) => match[0],
  },
  {
    id: "slack-token",
    label: "Slack token format",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    value: (match) => match[0],
  },
  {
    id: "connection-password",
    label: "Connection string password",
    pattern: /\b(?:Password|Pwd)\s*=\s*(?:["']([^"']+)["']|([^;\s]+))/gi,
    value: (match) => match[1] ?? match[2] ?? "",
    validateValue: true,
  },
  {
    id: "credential-assignment",
    label: "Credential assignment",
    pattern: /["']?(?:password|api[_-]?key|token)["']?\s*[:=]\s*["']([^"']+)["']/gi,
    value: (match) => match[1] ?? "",
    validateValue: true,
  },
];

interface SecretSignal {
  id: string;
  label: string;
  value: string;
}

export class SecretAnalyzer implements Analyzer {
  readonly name = "secret";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const change of context.changes.files) {
      if (change.type === "deleted") continue;

      const beforePath = change.type === "renamed" ? change.previousPath ?? change.path : change.path;
      const [beforeContent, afterContent] = await Promise.all([
        context.files.readBefore(beforePath),
        context.files.readAfter(change.path),
      ]);
      const after = decodeText(afterContent);
      if (after === null) continue;

      const before = beforeContent === null ? "" : decodeText(beforeContent);
      if (beforeContent !== null && before === null) continue;

      const existingSignals = new Set(
        detectSignals(before ?? "").map((signal) => signalSignature(signal)),
      );
      const introducedLines = compareLines(before ?? "", after).introduced;
      const reported = new Set<string>();

      for (const signal of detectSignals(introducedLines.join("\n"))) {
        const signature = signalSignature(signal);
        if (existingSignals.has(signature) || reported.has(signature)) continue;
        reported.add(signature);
        findings.push(toFinding(change, signal));
      }
    }

    return findings;
  }
}

function detectSignals(content: string): SecretSignal[] {
  const signals: SecretSignal[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (isCommentOrExampleLine(line)) continue;
    const occupiedStarts = new Set<number>();

    for (const definition of SECRET_PATTERNS) {
      definition.pattern.lastIndex = 0;
      for (const match of line.matchAll(definition.pattern)) {
        const start = match.index ?? -1;
        if (occupiedStarts.has(start)) continue;
        const value = definition.value(match).trim();
        if (definition.validateValue && !isHighConfidenceValue(value)) continue;
        if (isPlaceholder(value)) continue;

        occupiedStarts.add(start);
        signals.push({ id: definition.id, label: definition.label, value });
      }
    }
  }

  return signals;
}

function isCommentOrExampleLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(#|\/\/|\/\*|\*|<!--)/.test(trimmed);
}

function isHighConfidenceValue(value: string): boolean {
  if (value.length < 12) return false;
  const characterClasses = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;
  return characterClasses >= 2 || value.length >= 20;
}

function isPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  if (value === "AKIAIOSFODNN7EXAMPLE") return true;
  return /example|placeholder|change[-_ ]?me|replace[-_ ]?me|dummy|sample|your[-_ ]|<[^>]+>|\$\{|\{\{|\*{3,}/i
    .test(normalized);
}

function signalSignature(signal: SecretSignal): string {
  return signal.value;
}

function toFinding(change: FileChange, signal: SecretSignal): Finding {
  return {
    id: FINDING_IDS.possibleSecret,
    severity: "high",
    category: "secret",
    title: "Possible secret",
    description: `${signal.label} was introduced in changed text. Confirm that it is not a credential that should be stored outside version control.`,
    action: actionForFinding(FINDING_IDS.possibleSecret),
    files: [change.path],
    evidence: [
      `Signal: ${signal.label}`,
      "Matched value: ********",
    ],
  };
}
