import type { ReviewResult } from "./types.ts";

export const REVIEW_REPORT_SCHEMA_VERSION = 1 as const;

/** Portable, data-only representation of a completed review. */
export interface ReviewReport {
  schemaVersion: typeof REVIEW_REPORT_SCHEMA_VERSION;
  context: { checkpoint: { head: string; branch: string | null }; current: { head: string; branch: string | null }; headChanged: boolean; branchChanged: boolean };
  changes: ReviewResult["changes"];
  findings: ReviewResult["findings"];
  risk: ReviewResult["risk"];
  verdict: ReviewResult["verdict"];
}

/** Explicit transport boundary; excludes content providers and checkpoint internals. */
export function toReviewReport(result: ReviewResult): ReviewReport {
  return {
    schemaVersion: REVIEW_REPORT_SCHEMA_VERSION,
    context: { checkpoint: { head: result.checkpoint.head, branch: result.checkpoint.branch }, current: { head: result.current.head, branch: result.current.branch }, headChanged: result.headChanged, branchChanged: result.branchChanged },
    changes: { files: result.changes.files.map((file) => ({ ...file })) },
    findings: result.findings.map((finding) => ({ ...finding, files: [...finding.files], ...(finding.evidence ? { evidence: [...finding.evidence] } : {}) })),
    risk: { ...result.risk, contributions: result.risk.contributions.map((contribution) => ({ ...contribution })) },
    verdict: result.verdict,
  };
}
