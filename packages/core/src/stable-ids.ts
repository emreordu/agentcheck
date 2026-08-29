export const FINDING_IDS = {
  databaseMigrationChanged: "database.migration-changed",
  configurationChanged: "configuration.changed",
  productionConfigurationChanged: "configuration.production-changed",
  configurationFileDeleted: "configuration.file-deleted",
  gitIgnoreChanged: "repository.git-ignore-changed",
  gitAttributesChanged: "repository.git-attributes-changed",
  repositoryControlFileDeleted: "repository.control-file-deleted",
  ciCdConfigurationChanged: "delivery.ci-cd-configuration-changed",
  ciCdFileDeleted: "delivery.ci-cd-file-deleted",
  dependencyAdded: "dependency.added",
  dependencyRemoved: "dependency.removed",
  dependencyUpdated: "dependency.updated",
  dependencyConfigurationChanged: "dependency.configuration-changed",
  largeChangeSet: "review.large-change-set",
  largeFileAdded: "review.large-file-added",
  possibleSecret: "security.possible-secret",
  accessControlWeakened: "security.access-control-weakened",
  anonymousAccessIntroduced: "security.anonymous-access-introduced",
  securityBehaviorDisabled: "security.behavior-disabled",
  bootstrapChanged: "runtime.bootstrap-changed",
  testDisabled: "testing.test-disabled",
  sensitiveFileChanged: "security.sensitive-file-changed",
  testsNeedReview: "testing.coverage-review-needed",
} as const;
export type FindingId = typeof FINDING_IDS[keyof typeof FINDING_IDS];

export const RISK_CONTRIBUTION_IDS = {
  accessControlWeakened: "security.access-control-weakened",
  securityBehaviorDisabled: "security.behavior-disabled",
  anonymousAccessIntroduced: "security.anonymous-access-introduced",
  bootstrapChanged: "runtime.bootstrap-changed",
  testDisabled: "testing.test-disabled",
  sensitiveFileChanged: "security.sensitive-file-changed",
  databaseMigration: "database.migration",
  possibleSecret: "security.possible-secret",
  productionConfiguration: "configuration.production-changed",
  configurationChanged: "configuration.changed",
  dependencyAdded: "dependency.added",
  deletedFile: "review.file-deleted",
  ciCdChange: "delivery.ci-cd-changed",
  largeChange: "review.large-change",
  testsNeedReview: "testing.coverage-review-needed",
} as const;
export type RiskContributionId = typeof RISK_CONTRIBUTION_IDS[keyof typeof RISK_CONTRIBUTION_IDS];
export const BUILT_IN_FINDING_IDS = Object.values(FINDING_IDS) as readonly FindingId[];
export const BUILT_IN_RISK_CONTRIBUTION_IDS = Object.values(RISK_CONTRIBUTION_IDS) as readonly RiskContributionId[];
