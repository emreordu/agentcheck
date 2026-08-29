import { FINDING_IDS } from "../stable-ids.ts";
import { actionForFinding } from "../finding-actions.ts";
import type { AnalysisContext, Analyzer, Finding } from "../types.ts";

export const LARGE_CHANGE_THRESHOLDS = {
  changedFiles: 50,
  largeFileBytes: 1_000_000,
} as const;

export class LargeChangeAnalyzer implements Analyzer {
  readonly name = "large-change";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    if (context.changes.files.length >= LARGE_CHANGE_THRESHOLDS.changedFiles) {
      findings.push({
        id: FINDING_IDS.largeChangeSet,
        severity: "warning",
        category: "large-change",
        title: "Large change set",
        description: `${context.changes.files.length} files changed since checkpoint. Review the change set in manageable groups and confirm that its scope is intentional.`,
        action: actionForFinding(FINDING_IDS.largeChangeSet),
        files: [],
        evidence: [`Changed file threshold: ${LARGE_CHANGE_THRESHOLDS.changedFiles}`],
      });
    }

    for (const change of context.changes.files) {
      if (change.type !== "created") continue;
      const content = await context.files.readAfter(change.path);
      if (content === null || content.byteLength < LARGE_CHANGE_THRESHOLDS.largeFileBytes) continue;

      findings.push({
        severity: "warning",
        category: "large-change",
        id: FINDING_IDS.largeFileAdded,
        title: "Large file added",
        description: `${change.path} was added with a size of ${formatBytes(content.byteLength)}. Confirm that the file belongs in the repository and does not make reviews or distribution unnecessarily heavy.`,
        action: actionForFinding(FINDING_IDS.largeFileAdded),
        files: [change.path],
        evidence: [
          `Added file size: ${content.byteLength} bytes`,
          `Large file threshold: ${LARGE_CHANGE_THRESHOLDS.largeFileBytes} bytes`,
        ],
      });
    }

    return findings;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${bytes} bytes`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
