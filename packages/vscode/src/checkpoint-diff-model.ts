import { createHash } from "node:crypto";
import type { FileChange, ReviewResult } from "@agentcheck/core";

export const CHECKPOINT_DIFF_MAX_TEXT_BYTES = 4 * 1024 * 1024;

export type CheckpointDiffSide = "checkpoint" | "current";

export interface CheckpointDiffDocument {
  side: CheckpointDiffSide;
  path: string;
}

/**
 * The in-memory, review-scoped bridge between Core snapshot content and VS Code
 * virtual documents. It deliberately does not serialize content or Git metadata.
 */
export class CheckpointDiffReview {
  readonly id: string;

  constructor(readonly result: ReviewResult) {
    this.id = createHash("sha256")
      .update(result.checkpoint.tree)
      .update("\0")
      .update(result.current.tree)
      .digest("hex")
      .slice(0, 16);
  }

  resolveChange(candidate: unknown): FileChange | undefined {
    if (isFileChange(candidate)) {
      return this.result.changes.files.find((change) => sameChange(change, candidate));
    }
    if (!isPathDescriptor(candidate)) return undefined;

    const matches = this.result.changes.files.filter(
      (change) => change.path === candidate.path || change.previousPath === candidate.path,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  documentsFor(change: FileChange): readonly [CheckpointDiffDocument, CheckpointDiffDocument] {
    return [
      { side: "checkpoint", path: change.previousPath ?? change.path },
      { side: "current", path: change.path },
    ];
  }

  async readText(document: CheckpointDiffDocument): Promise<string> {
    const change = this.changeForDocument(document);
    if (!change) {
      throw new Error("The requested content is not part of the active AgentCheck review.");
    }

    const content = document.side === "checkpoint"
      ? await this.result.content.readBefore(document.path)
      : await this.result.content.readAfter(document.path);
    return decodeSnapshotText(content, change.path);
  }

  private changeForDocument(document: CheckpointDiffDocument): FileChange | undefined {
    return this.result.changes.files.find((change) => {
      const path = document.side === "checkpoint" ? change.previousPath ?? change.path : change.path;
      return path === document.path;
    });
  }
}

export function checkpointDiffTitle(change: FileChange): string {
  const displayPath = change.type === "renamed"
    ? `${change.previousPath ?? change.path} → ${change.path}`
    : change.path;
  return `AgentCheck: ${displayPath} — Checkpoint ↔ Current`;
}

function decodeSnapshotText(content: Buffer | null, path: string): string {
  if (content === null) return "";
  if (content.byteLength > CHECKPOINT_DIFF_MAX_TEXT_BYTES) {
    throw new Error(`A text diff is unavailable because ${path} exceeds the AgentCheck diff size limit.`);
  }
  if (content.includes(0)) {
    throw new Error(`A text diff is unavailable because ${path} is binary.`);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`A text diff is unavailable because ${path} is not valid UTF-8 text.`);
  }
}

function isFileChange(value: unknown): value is FileChange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.type === "modified" || candidate.type === "created" || candidate.type === "deleted" || candidate.type === "renamed")
    && typeof candidate.path === "string"
    && (candidate.previousPath === undefined || typeof candidate.previousPath === "string");
}

function isPathDescriptor(value: unknown): value is { path: string } {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).path === "string";
}

function sameChange(left: FileChange, right: FileChange): boolean {
  return left.type === right.type && left.path === right.path && left.previousPath === right.previousPath;
}
