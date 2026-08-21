import { execFile } from "node:child_process";
import { delimiter, isAbsolute, resolve } from "node:path";

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface GitRepository {
  root: string;
  gitDir: string;
  commonDir: string;
  objectDirectory: string;
  agentcheckDirectory: string;
  agentcheckObjectDirectory: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    allowedExitCodes?: readonly number[];
  } = {},
): Promise<Buffer> {
  const result = await executeGit(cwd, args, options.env);
  const allowedExitCodes = options.allowedExitCodes ?? [0];

  if (!allowedExitCodes.includes(result.exitCode)) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new GitError(
      `git ${args[0] ?? "command"} failed${stderr ? `: ${stderr}` : ""}`,
      args,
      result.exitCode,
      stderr,
    );
  }

  return result.stdout;
}

export async function resolveRepository(cwd: string): Promise<GitRepository> {
  const root = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = await gitAbsolutePath(root, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = await gitAbsolutePath(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const objectDirectory = await gitAbsolutePath(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const agentcheckDirectory = await gitAbsolutePath(root, ["rev-parse", "--path-format=absolute", "--git-path", "agentcheck"]);

  return {
    root,
    gitDir,
    commonDir,
    objectDirectory,
    agentcheckDirectory,
    agentcheckObjectDirectory: resolve(agentcheckDirectory, "objects"),
  };
}

export async function readHead(repository: GitRepository): Promise<string> {
  try {
    return await gitText(repository.root, ["rev-parse", "--verify", "HEAD"]);
  } catch (error) {
    if (error instanceof GitError) {
      throw new Error("AgentCheck requires a repository with at least one commit (HEAD could not be resolved).", { cause: error });
    }
    throw error;
  }
}

export async function readBranch(repository: GitRepository): Promise<string | null> {
  const output = await runGit(
    repository.root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { allowedExitCodes: [0, 1] },
  );

  const branch = output.toString("utf8").trim();
  return branch || null;
}

export function snapshotEnvironment(repository: GitRepository, indexFile: string): NodeJS.ProcessEnv {
  const existingAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const alternates = existingAlternates
    ? `${repository.objectDirectory}${delimiter}${existingAlternates}`
    : repository.objectDirectory;

  return {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_OBJECT_DIRECTORY: repository.agentcheckObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
  };
}

export function objectEnvironment(repository: GitRepository): NodeJS.ProcessEnv {
  const environment = snapshotEnvironment(repository, "");
  delete environment.GIT_INDEX_FILE;
  return environment;
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await runGit(cwd, args)).toString("utf8").trim();
}

async function gitAbsolutePath(cwd: string, args: readonly string[]): Promise<string> {
  const value = await gitText(cwd, args);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function executeGit(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: env ?? process.env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }

        resolvePromise({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
          exitCode: error && typeof error.code === "number" ? error.code : 0,
        });
      },
    );
  });
}
