import { FINDING_IDS, type FindingId } from "./stable-ids.ts";

/** Deterministic, Core-owned next-review steps for built-in findings. */
export const BUILT_IN_FINDING_ACTIONS: Readonly<Record<FindingId, string>> = {
  [FINDING_IDS.databaseMigrationChanged]: "Review the migration for destructive schema operations, data transformations, and rollback implications.",
  [FINDING_IDS.configurationChanged]: "Review the changed runtime configuration for environment-specific values, endpoints, credentials, and behavior flags.",
  [FINDING_IDS.productionConfigurationChanged]: "Verify the changed production configuration uses the intended environment-specific values, endpoints, credentials, and behavior flags.",
  [FINDING_IDS.configurationFileDeleted]: "Confirm that runtime, deployment, and automation no longer depend on the deleted configuration.",
  [FINDING_IDS.gitIgnoreChanged]: "Review the changed ignore patterns and confirm expected generated and local files remain visible to Git.",
  [FINDING_IDS.gitAttributesChanged]: "Review the changed attribute rules for line endings, merge behavior, and binary-file handling.",
  [FINDING_IDS.repositoryControlFileDeleted]: "Confirm repository tooling and automation no longer depend on the deleted control file.",
  [FINDING_IDS.ciCdConfigurationChanged]: "Review the changed CI/CD triggers, permissions, and referenced settings.",
  [FINDING_IDS.ciCdFileDeleted]: "Confirm delivery workflows and repository automation no longer depend on the deleted CI/CD file.",
  [FINDING_IDS.dependencyAdded]: "Review the added dependency's source, version, license, and compatibility with the project.",
  [FINDING_IDS.dependencyConfigurationChanged]: "Inspect the manifest diff for package additions, removals, version changes, and lockfile implications.",
  [FINDING_IDS.largeChangeSet]: "Review the change set in manageable groups and confirm its scope is intentional.",
  [FINDING_IDS.largeFileAdded]: "Verify the added file belongs in the repository and is appropriate for review and distribution.",
  [FINDING_IDS.possibleSecret]: "Inspect the affected credential handling and confirm any sensitive value is intended, protected, and not committed inadvertently.",
  [FINDING_IDS.accessControlWeakened]: "Verify the changed authentication or authorization behavior still matches the intended access policy.",
  [FINDING_IDS.anonymousAccessIntroduced]: "Verify that the new public access is intentional and inspect the affected authentication and authorization boundaries.",
  [FINDING_IDS.securityBehaviorDisabled]: "Inspect the disabled security or runtime behavior and verify the resulting protection remains intentional.",
  [FINDING_IDS.bootstrapChanged]: "Review startup and request-pipeline behavior for the changed application wiring.",
  [FINDING_IDS.testDisabled]: "Review the disabled test and confirm the coverage gap is intentional.",
  [FINDING_IDS.sensitiveFileChanged]: "Inspect the sensitive-file diff and confirm no credentials or key material were introduced unintentionally.",
  [FINDING_IDS.testsNeedReview]: "Review related tests and verify the changed behavior remains covered.",
};

export function actionForFinding(id: FindingId): string {
  return BUILT_IN_FINDING_ACTIONS[id];
}
