export interface Checkpoint {
  schemaVersion: 1;
  createdAt: string;
  head: string;
  branch: string | null;
  tree: string;
}

export interface Snapshot {
  head: string;
  branch: string | null;
  tree: string;
}

export type FileChangeType =
  | "modified"
  | "created"
  | "deleted"
  | "renamed";

export interface FileChange {
  type: FileChangeType;
  path: string;
  previousPath?: string;
}

export interface ChangeSet {
  files: FileChange[];
}

export interface ReviewResult {
  changes: ChangeSet;
  findings: Finding[];
  risk: RiskAssessment;
  verdict: Verdict;
  checkpoint: Checkpoint;
  current: Snapshot;
  headChanged: boolean;
  branchChanged: boolean;
  content: FileContentProvider;
}

export interface FileContentProvider {
  readBefore(path: string): Promise<Buffer | null>;
  readAfter(path: string): Promise<Buffer | null>;
}

export type FindingSeverity = "info" | "warning" | "high";

export type FindingCategory =
  | "database"
  | "configuration"
  | "dependency"
  | "dangerous-file"
  | "large-change"
  | "secret"
  | "test-attention"
  | "semantic-risk"
  | "sensitive-file";

export interface Finding {
  /** Stable built-in machine identity. */
  id?: import("./stable-ids.ts").FindingId;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  description: string;
  /** Deterministic, Core-authored next inspection step. */
  action: string;
  files: string[];
  evidence?: string[];
}

export interface AnalysisContext {
  checkpoint: Checkpoint;
  changes: ChangeSet;
  files: FileContentProvider;
}

export interface Analyzer {
  readonly name: string;
  analyze(context: AnalysisContext): Promise<Finding[]>;
}

export type RiskLevel = "low" | "medium" | "high";

export type Verdict =
  | "LOOKS ROUTINE"
  | "REVIEW RECOMMENDED"
  | "CAREFUL REVIEW RECOMMENDED";

export interface RiskContribution {
  /** Stable built-in machine identity. */
  id?: import("./stable-ids.ts").RiskContributionId;
  reason: string;
  points: number;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  contributions: RiskContribution[];
}
