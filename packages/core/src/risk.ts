import type { ChangeSet, Finding, RiskAssessment, RiskLevel, Verdict } from "./types.ts";

export const RISK_LEVEL_THRESHOLDS = {
  medium: 3,
  high: 7,
} as const;

export const RISK_WEIGHTS = {
  migration: 5,
  possibleSecret: 5,
  productionConfiguration: 4,
  configurationChange: 1,
  dependencyAddition: 3,
  deletedFile: 3,
  ciCdChange: 2,
  largeChange: 2,
  testAttention: 1,
} as const;

interface RiskRule {
  reason: string;
  points: number;
  applies(changes: ChangeSet, findings: readonly Finding[]): boolean;
}

const RISK_RULES: readonly RiskRule[] = [
  {
    reason: "Database migration",
    points: RISK_WEIGHTS.migration,
    applies: (_, findings) => findings.some((finding) => finding.category === "database"),
  },
  {
    reason: "Possible secret",
    points: RISK_WEIGHTS.possibleSecret,
    applies: (_, findings) => findings.some((finding) => finding.category === "secret"),
  },
  {
    reason: "Production configuration",
    points: RISK_WEIGHTS.productionConfiguration,
    applies: (_, findings) => findings.some((finding) =>
      finding.category === "configuration" && finding.title === "Production configuration changed"),
  },
  {
    reason: "Configuration changed",
    points: RISK_WEIGHTS.configurationChange,
    applies: (_, findings) => findings.some((finding) => finding.category === "configuration")
      && !findings.some((finding) =>
        finding.category === "configuration" && finding.title === "Production configuration changed"),
  },
  {
    reason: "Dependency addition",
    points: RISK_WEIGHTS.dependencyAddition,
    applies: (_, findings) => findings.some((finding) =>
      finding.category === "dependency" && finding.title === "Dependency added"),
  },
  {
    reason: "Deleted file",
    points: RISK_WEIGHTS.deletedFile,
    applies: (changes) => changes.files.some((file) => file.type === "deleted"),
  },
  {
    reason: "CI/CD change",
    points: RISK_WEIGHTS.ciCdChange,
    applies: (_, findings) => findings.some((finding) =>
      finding.category === "dangerous-file" && finding.title.startsWith("CI/CD")),
  },
  {
    reason: "Unusually large change",
    points: RISK_WEIGHTS.largeChange,
    applies: (_, findings) => findings.some((finding) => finding.category === "large-change"),
  },
  {
    reason: "Test attention",
    points: RISK_WEIGHTS.testAttention,
    applies: (_, findings) => findings.some((finding) => finding.category === "test-attention"),
  },
];

export function assessRisk(changes: ChangeSet, findings: readonly Finding[]): RiskAssessment {
  const contributions = RISK_RULES
    .filter((rule) => rule.applies(changes, findings))
    .map(({ reason, points }) => ({ reason, points }));
  const score = contributions.reduce((total, contribution) => total + contribution.points, 0);
  return { score, level: riskLevelForScore(score), contributions };
}

export function riskLevelForScore(score: number): RiskLevel {
  if (score >= RISK_LEVEL_THRESHOLDS.high) return "high";
  if (score >= RISK_LEVEL_THRESHOLDS.medium) return "medium";
  return "low";
}

export function verdictForRiskLevel(level: RiskLevel): Verdict {
  switch (level) {
    case "low": return "LOOKS ROUTINE";
    case "medium": return "REVIEW RECOMMENDED";
    case "high": return "CAREFUL REVIEW RECOMMENDED";
  }
}

export function verdictForReview(level: RiskLevel, findings: readonly Finding[]): Verdict {
  if (level === "high" || findings.some((finding) => finding.severity === "high")) {
    return "CAREFUL REVIEW RECOMMENDED";
  }
  if (level === "medium" || findings.some((finding) => finding.severity === "warning")) {
    return "REVIEW RECOMMENDED";
  }
  return "LOOKS ROUTINE";
}
