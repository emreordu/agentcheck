import { readFile } from "node:fs/promises";
import { clearCheckpoint, createCheckpoint, GitError, reviewChanges } from "@agentcheck/core";
import { formatCheckpointCreated, formatHelp, formatReview } from "./presentation.ts";

interface CliStreams {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
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

  write(streams.stderr, `Unknown command: ${args.join(" ")}\n\nRun:\n  agentcheck --help`);
  return 1;
}

async function runStart(cwd: string, streams: CliStreams): Promise<number> {
  try {
    const checkpoint = await createCheckpoint(cwd);
    write(streams.stdout, formatCheckpointCreated(checkpoint.branch, checkpoint.head));
    return 0;
  } catch (error) {
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
  try {
    write(streams.stdout, formatReview(await reviewChanges(cwd)));
    return 0;
  } catch (error) {
    if (hasMessage(error, "No active AgentCheck checkpoint")) {
      write(streams.stderr, "No active AgentCheck checkpoint.\n\nRun:\n  agentcheck start");
    } else {
      write(streams.stderr, formatFailure("AgentCheck could not review repository changes.", error));
    }
    return 1;
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
  return `${summary}\n\nReason:\n${formatReason(error)}`;
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
  stream.write(`${message}\n`);
}
