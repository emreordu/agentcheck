import { readFile } from "node:fs/promises";
import { clearCheckpoint, createCheckpoint, GitError, reviewChanges, toReviewReport } from "@agentcheck/core";
import { createProgress } from "./progress.ts";
import { formatCheckpointCreated, formatHelp, formatReview, type PresentationOptions } from "./presentation.ts";

interface CliStreams {
  stdout: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns">;
  stderr: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns">;
}

const defaultStreams: CliStreams = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export async function runCli(
  args: readonly string[],
  cwd = process.cwd(),
  streams: CliStreams = defaultStreams,
): Promise<number> {
  const command = args[0];

  if (args.length === 0 || (args.length === 1 && command === "check")) {
    return runCheck(cwd, streams);
  }


  if (args.length === 3 && command === "check" && args[1] === "--format" && args[2] === "json") {
    return runJsonCheck(cwd, streams);
  }
  if (args.length === 1 && command === "start") {
    return runStart(cwd, streams);
  }

  if (args.length === 1 && command === "clear") {
    return runClear(cwd, streams);
  }

  if (args.length === 1 && (command === "--help" || command === "-h")) {
    write(streams.stdout, formatHelp());
    return 0;
  }

  if (args.length === 1 && (command === "--version" || command === "-v")) {
    try {
      write(streams.stdout, await readPackageVersion());
      return 0;
    } catch (error) {
      write(streams.stderr, formatFailure("AgentCheck could not read its package version.", error));
      return 1;
    }
  }

  write(streams.stderr, "Unknown command: " + args.join(" ") + "\n\nRun:\n  agentcheck --help");
  return 1;
}

async function runStart(cwd: string, streams: CliStreams): Promise<number> {
  const options = presentationOptions(streams);
  const startedAt = Date.now();
  const progress = createProgress(streams.stderr, "Capturing repository baseline...", options);
  try {
    const checkpoint = await createCheckpoint(cwd);
    progress.stop();
    write(streams.stdout, formatCheckpointCreated(checkpoint.branch, checkpoint.head, withDuration(options, startedAt)));
    return 0;
  } catch (error) {
    progress.stop();
    if (hasMessage(error, "active AgentCheck checkpoint already exists")) {
      write(
        streams.stderr,
        "AgentCheck already has an active checkpoint.\n\nRun:\n  agentcheck clear\n\nbefore creating a new one.",
      );
    } else {
      write(streams.stderr, formatFailure("AgentCheck could not create a checkpoint.", error));
    }
    return 1;
  }
}

async function runCheck(cwd: string, streams: CliStreams): Promise<number> {
  const options = presentationOptions(streams);
  const startedAt = Date.now();
  const progress = createProgress(streams.stderr, "Analyzing repository...", options);
  try {
    const result = await reviewChanges(cwd);
    progress.stop();
    write(streams.stdout, formatReview(result, withDuration(options, startedAt)));
    return 0;
  } catch (error) {
    progress.stop();
    if (hasMessage(error, "No active AgentCheck checkpoint")) {
      write(streams.stderr, "No active AgentCheck checkpoint.\n\nRun:\n  agentcheck start");
    } else if (
      hasMessage(error, "checkpoint metadata could not be read")
      || hasMessage(error, "checkpoint metadata is invalid")
    ) {
      write(
        streams.stderr,
        "The active AgentCheck checkpoint is corrupted or unsupported.\n\nRun:\n  agentcheck clear\n  agentcheck start",
      );
    } else {
      write(streams.stderr, formatFailure("AgentCheck could not review repository changes.", error));
    }
    return 1;
  }
}

async function runJsonCheck(cwd: string, streams: CliStreams): Promise<number> {
  try {
    const result = await reviewChanges(cwd);
    write(streams.stdout, JSON.stringify(toReviewReport(result), null, 2));
    return 0;
  } catch (error) {
    writeJsonCheckFailure(streams.stderr, error);
    return 1;
  }
}

function writeJsonCheckFailure(stream: Pick<NodeJS.WriteStream, "write">, error: unknown): void {
  if (hasMessage(error, "No active AgentCheck checkpoint")) {
    write(stream, "No active AgentCheck checkpoint.\n\nRun:\n  agentcheck start");
  } else if (hasMessage(error, "checkpoint metadata could not be read") || hasMessage(error, "checkpoint metadata is invalid")) {
    write(stream, "The active AgentCheck checkpoint is corrupted or unsupported.\n\nRun:\n  agentcheck clear\n  agentcheck start");
  } else {
    write(stream, formatFailure("AgentCheck could not review repository changes.", error));
  }
}

async function runClear(cwd: string, streams: CliStreams): Promise<number> {
  try {
    await clearCheckpoint(cwd);
    write(streams.stdout, "✓ Checkpoint cleared");
    return 0;
  } catch (error) {
    write(streams.stderr, formatFailure("AgentCheck could not clear the checkpoint.", error));
    return 1;
  }
}

async function readPackageVersion(): Promise<string> {
  const packageUrl = new URL("../package.json", import.meta.url);
  const value: unknown = JSON.parse(await readFile(packageUrl, "utf8"));

  if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string") {
    throw new Error("The package version is missing or invalid.");
  }

  return value.version;
}

function formatFailure(summary: string, error: unknown): string {
  return summary + "\n\nReason:\n" + formatReason(error);
}

function formatReason(error: unknown): string {
  if (isNodeError(error) && error.code === "ENOENT") {
    return "Git executable was not found.";
  }

  if (error instanceof GitError) {
    if (error.stderr.includes("not a git repository")) {
      return "This directory is not inside a Git repository.";
    }
    return stripGitPrefix(error.stderr) || "Git could not complete the requested operation.";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred.";
}

function stripGitPrefix(message: string): string {
  return message.replace(/^fatal:\s*/i, "").trim();
}

function hasMessage(error: unknown, fragment: string): boolean {
  return error instanceof Error && error.message.includes(fragment);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function write(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message + "\n");
}

function presentationOptions(streams: CliStreams): PresentationOptions {
  const interactive = streams.stdout.isTTY === true && streams.stderr.isTTY === true;
  const width = interactive && typeof streams.stdout.columns === "number" ? streams.stdout.columns : undefined;
  return { interactive, color: interactive && !("NO_COLOR" in process.env), width };
}

function withDuration(options: PresentationOptions, startedAt: number): PresentationOptions {
  return { ...options, durationMs: Date.now() - startedAt };
}
