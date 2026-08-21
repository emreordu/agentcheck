import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [cliEntry, temporaryParent] = process.argv.slice(2);
if (!cliEntry || !temporaryParent) {
  throw new Error("Usage: node scripts/cli-package-smoke.mjs <installed-cli-entry> <temporary-parent>");
}

const repository = await mkdtemp(join(temporaryParent, "repository-"));
await git(["init"], repository);
await git(["config", "user.email", "agentcheck-smoke@example.invalid"], repository);
await git(["config", "user.name", "AgentCheck Smoke"], repository);
await mkdir(join(repository, "src"), { recursive: true });

await Promise.all([
  writeFile(join(repository, "src", "OrderService.ts"), "export const value = 1;\n"),
  writeFile(join(repository, "src", "space ünicode.ts"), "export const unicode = true;\n"),
  writeFile(join(repository, "obsolete.txt"), "remove after checkpoint\n"),
  writeFile(join(repository, "package.json"), '{"name":"smoke","private":true}\n'),
  ...Array.from({ length: 200 }, (_, index) =>
    writeFile(join(repository, `fixture-${String(index).padStart(3, "0")}.txt`), `${index}\n`),
  ),
]);
await git(["add", "."], repository);
await git(["commit", "-m", "initial"], repository);

await writeFile(join(repository, "staged-before.txt"), "pre-existing staged state\n");
await git(["add", "staged-before.txt"], repository);
const indexPath = await gitText(["rev-parse", "--git-path", "index"], repository);
const indexBefore = await readFile(join(repository, indexPath));

const startAt = performance.now();
const start = await cli(["start"], repository);
const startMilliseconds = Math.round(performance.now() - startAt);
assert.match(start.stdout, /Checkpoint created/);

const fakeCredential = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
await mkdir(join(repository, "Migrations"));
await Promise.all([
  writeFile(
    join(repository, "src", "OrderService.ts"),
    Array.from({ length: 30 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n",
  ),
  writeFile(join(repository, "src", "space ünicode.ts"), "export const unicode = false;\n"),
  writeFile(join(repository, "appsettings.Production.json"), `{"api_key":"${fakeCredential}"}\n`),
  writeFile(join(repository, "Migrations", "20260819_AddOrderIndex.sql"), "-- controlled migration fixture\n"),
  writeFile(join(repository, "package.json"), '{"name":"smoke","private":true,"dependencies":{"left-pad":"1.3.0"}}\n'),
]);
await rm(join(repository, "obsolete.txt"));

const reviewAt = performance.now();
const review = await cli([], repository);
const reviewMilliseconds = Math.round(performance.now() - reviewAt);
assert.match(review.stdout, /Changes/);
assert.match(review.stdout, /Possible secret/);
assert.equal(
  review.stdout.split(/\r?\n/).filter((line) => line === "Possible secret").length,
  1,
  "One introduced secret value produced duplicate CLI findings.",
);
assert.match(review.stdout, /Database migration added/);
assert.match(review.stdout, /Production configuration changed/);
assert.match(review.stdout, /Dependency added/);
assert.match(review.stdout, /Test attention/);
assert.match(review.stdout, /Risk/);
assert.match(review.stdout, /Verdict/);
assertSecretAbsent(review.stdout, fakeCredential, "CLI stdout");
assertSecretAbsent(review.stderr, fakeCredential, "CLI stderr");

const indexAfter = await readFile(join(repository, indexPath));
assert.deepEqual(indexAfter, indexBefore, "The real Git index changed during start/review.");
assert.match((await cli(["clear"], repository)).stdout, /Checkpoint cleared/);

process.stdout.write(review.stdout);
process.stdout.write(`\nPackage smoke: PASS (${startMilliseconds} ms start, ${reviewMilliseconds} ms review, 204-file baseline)\n`);

async function cli(args, cwd) {
  return execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function git(args, cwd) {
  await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function gitText(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

function assertSecretAbsent(output, secret, surface) {
  if (output.includes(secret)) {
    assert.fail(`A fake credential was exposed in ${surface}.`);
  }
}
