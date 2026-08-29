import { FINDING_IDS, RISK_CONTRIBUTION_IDS } from "./stable-ids.ts";
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
  accessControlWeakened: 7,
  securityBehaviorDisabled: 7,
  anonymousAccessIntroduced: 2,
  bootstrapChanged: 2,
  testDisabled: 3,
  sensitiveFileChanged: 2,
} as const;

interface RiskRule {
  id: NonNullable<import("./types.ts").RiskContribution["id"]>;
  reason: string;
  points: number;
  applies(changes: ChangeSet, findings: readonly Finding[]): boolean;
}

const RISK_RULES: readonly RiskRule[] = [
  { id: RISK_CONTRIBUTION_IDS.accessControlWeakened, reason: "Access control weakened", points: RISK_WEIGHTS.accessControlWeakened, applies: (_, findings) => hasFinding(findings, FINDING_IDS.accessControlWeakened) },
  { id: RISK_CONTRIBUTION_IDS.securityBehaviorDisabled, reason: "Security behavior disabled", points: RISK_WEIGHTS.securityBehaviorDisabled, applies: (_, findings) => hasFinding(findings, FINDING_IDS.securityBehaviorDisabled) },
  { id: RISK_CONTRIBUTION_IDS.anonymousAccessIntroduced, reason: "Anonymous access introduced", points: RISK_WEIGHTS.anonymousAccessIntroduced, applies: (_, findings) => hasFinding(findings, FINDING_IDS.anonymousAccessIntroduced) },
  { id: RISK_CONTRIBUTION_IDS.bootstrapChanged, reason: "Application bootstrap changed", points: RISK_WEIGHTS.bootstrapChanged, applies: (_, findings) => hasFinding(findings, FINDING_IDS.bootstrapChanged) },
  { id: RISK_CONTRIBUTION_IDS.testDisabled, reason: "Tests may have been disabled", points: RISK_WEIGHTS.testDisabled, applies: (_, findings) => hasFinding(findings, FINDING_IDS.testDisabled) },
  { id: RISK_CONTRIBUTION_IDS.sensitiveFileChanged, reason: "Sensitive file changed", points: RISK_WEIGHTS.sensitiveFileChanged, applies: (_, findings) => hasStandaloneSensitiveFile(findings) },
  { id: RISK_CONTRIBUTION_IDS.databaseMigration, reason: "Database migration", points: RISK_WEIGHTS.migration, applies: (_, findings) => findings.some((finding) => finding.category === "database") },
  { id: RISK_CONTRIBUTION_IDS.possibleSecret, reason: "Possible secret", points: RISK_WEIGHTS.possibleSecret, applies: (_, findings) => findings.some((finding) => finding.category === "secret") },
  { id: RISK_CONTRIBUTION_IDS.productionConfiguration, reason: "Production configuration", points: RISK_WEIGHTS.productionConfiguration, applies: (_, findings) => hasFinding(findings, FINDING_IDS.productionConfigurationChanged) },
  { id: RISK_CONTRIBUTION_IDS.configurationChanged, reason: "Configuration changed", points: RISK_WEIGHTS.configurationChange, applies: (_, findings) => findings.some((finding) => finding.category === "configuration") && !hasFinding(findings, FINDING_IDS.productionConfigurationChanged) },
  { id: RISK_CONTRIBUTION_IDS.dependencyAdded, reason: "Dependency addition", points: RISK_WEIGHTS.dependencyAddition, applies: (_, findings) => hasFinding(findings, FINDING_IDS.dependencyAdded) },
  { id: RISK_CONTRIBUTION_IDS.deletedFile, reason: "Deleted file", points: RISK_WEIGHTS.deletedFile, applies: (changes) => changes.files.some((file) => file.type === "deleted") },
  { id: RISK_CONTRIBUTION_IDS.ciCdChange, reason: "CI/CD change", points: RISK_WEIGHTS.ciCdChange, applies: (_, findings) => hasFinding(findings, FINDING_IDS.ciCdConfigurationChanged) || hasFinding(findings, FINDING_IDS.ciCdFileDeleted) },
  { id: RISK_CONTRIBUTION_IDS.largeChange, reason: "Unusually large change", points: RISK_WEIGHTS.largeChange, applies: (_, findings) => findings.some((finding) => finding.category === "large-change") },
  { id: RISK_CONTRIBUTION_IDS.testsNeedReview, reason: "Tests may need review", points: RISK_WEIGHTS.testAttention, applies: (_, findings) => findings.some((finding) => finding.category === "test-attention") },
];

function hasFinding(findings: readonly Finding[], id: NonNullable<Finding["id"]>): boolean { return findings.some((finding) => finding.id === id); }

function hasStandaloneSensitiveFile(findings: readonly Finding[]): boolean {
  const configurationPaths = new Set(
    findings.filter((finding) => finding.category === "configuration").flatMap((finding) => finding.files),
  );
  return findings
    .filter((finding) => finding.category === "sensitive-file")
    .some((finding) => finding.files.some((path) => !configurationPaths.has(path)));
}

export function assessRisk(changes: ChangeSet, findings: readonly Finding[]): RiskAssessment {
  const contributions = RISK_RULES
    .filter((rule) => rule.applies(changes, findings))
    .map(({ id, reason, points }) => ({ id, reason, points }));
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
