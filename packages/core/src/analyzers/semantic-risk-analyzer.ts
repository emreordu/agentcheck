import { compareLines, decodeText } from "../line-diff.ts";
import type { AnalysisContext, Analyzer, FileChange, Finding } from "../types.ts";

const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]*\.(?:pem|key)|(?:credentials|secrets|service-account)[^/]*\.(?:json|ya?ml)|\.npmrc|\.pypirc|gradle\.properties)$/i;
const BOOTSTRAP_BASENAME = /^(?:program|startup|main|__main__|server|app|index|cli|preload|middleware)\.(?:cs|go|py|js|jsx|ts|tsx|dart)$/i;
const IOS_BOOTSTRAP_BASENAME = /^(?:appdelegate|scenedelegate)/i;
const BIN_ENTRYPOINT = /(?:^|\/)bin\/[^/]+\.(?:js|ts|py)$/i;
const JAVA_MAIN = /\bpublic\s+static\s+void\s+main\s*\(\s*String(?:\[\]|\.\.\.)\s+\w+\s*\)/;
const BOOTSTRAP_WIRING = [
  /\b(?:app|router|server)\s*\.\s*(?:use|listen|run|start|register|route)\s*\(/i,
  /\b(?:builder\.services|app)\s*\.\s*(?:add|use|map)\w*\s*\(/i,
  /\b(?:program|command)\s*\.\s*(?:command|action|option|parse)\s*\(/i,
  /\bapp\s*\.\s*(?:add_middleware|include_router)\s*\(|\buvicorn\s*\.\s*run\s*\(/i,
  /\bSpringApplication\s*\.\s*run\s*\(|\bSpringApplicationBuilder\s*\(|\.\s*add(?:Initializers|Listeners)\s*\(/,
  /\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*addShutdownHook\s*\(/,
  /\b[A-Z]\w*\s*\.\s*(?:[Rr]un|[Ss]tart|[Ii]nitialize|[Rr]egister)\s*\(/,
  /\brunApp\s*\(/,
  /\b(?:app\s*\.\s*whenReady|ipcMain\s*\.\s*(?:handle|on)|contextBridge\s*\.\s*exposeInMainWorld|protocol\s*\.\s*handle)\s*\(|\bnew\s+BrowserWindow\s*\(/i,
  /\bNextResponse\s*\.\s*(?:next|redirect|rewrite)\s*\(/,
  /\b(?:application|scene)\s*\(|\bregisterForRemoteNotifications\s*\(/,
] as const;
const AUTHORIZED = /(?:\[\s*Authorize\s*\]|\bIsAuthenticated\b|\bauth(?:entication)?Middleware\b|\b(?:PreAuthorize|UseGuards|AuthGuard)\b)/i;
const ANONYMOUS = /(?:\[\s*AllowAnonymous\s*\]|\bAllowAny\b|\b(?:allowAnonymous|public)\s*[:=]\s*true\b)/i;
const ROUTE_WITH_GUARD = /\b(?:router|app)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\([^\n,]+,\s*[^\n,]*(?:auth|guard|protect)[^\n,]*/i;
const ROUTE_WITHOUT_GUARD = /\b(?:router|app)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\([^\n,]+,\s*(?![^\n)]*(?:auth|guard|protect))[^\n)]*\)/i;
const CRITICAL_RUNTIME = /(?:useauthentication|useauthorization|usehttpsredirection|usehsts|mapcontrollers|usemiddleware|auth(?:entication|orization)?|useguards|preauthorize)/i;
const TEST_DISABLED = /(?:\b(?:it|test|describe)\.skip\s*\(|@pytest\.mark\.skip\b|@Disabled\b|\[\s*(?:Fact|Theory)\s*\(\s*Skip\s*=)/;
const DART_TEST_DISABLED = /\bskip\s*:\s*true\b/;

export class SemanticRiskAnalyzer implements Analyzer {
  readonly name = "semantic-risk";

  async analyze(context: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const change of context.changes.files) {
      const beforePath = change.type === "renamed" ? change.previousPath ?? change.path : change.path;
      const [beforeContent, afterContent] = await Promise.all([
        context.files.readBefore(beforePath),
        context.files.readAfter(change.path),
      ]);
      const before = decodeText(beforeContent);
      const after = decodeText(afterContent);
      if (before === null && after === null) continue;

      const removed = removedLines(before ?? "", after ?? "");
      const introduced = compareLines(before ?? "", after ?? "").introduced;
      if (SENSITIVE_PATH.test(normalizePath(change.path))) findings.push(sensitiveFileFinding(change));
      const accessControlWeakened = isSourcePath(change.path)
        && hasAccessControlWeakening(change.path, removed, introduced);
      if (accessControlWeakened) findings.push(accessControlFinding(change));
      else if (hasAnonymousAccessIntroduced(change, introduced)) findings.push(anonymousAccessFinding(change));
      const disabledCriticalCall = isSourcePath(change.path)
        ? criticalCommentOutEvidence(removed, introduced)
        : null;
      if (disabledCriticalCall) findings.push(disabledSecurityFinding(change, disabledCriticalCall));
      if (!disabledCriticalCall
        && isBootstrapPath(change.path, before ?? "", after ?? "")
        && hasExecutableWiring(removed, introduced)) findings.push(bootstrapFinding(change));
      if (isTestPath(change.path) && hasTestDisable(change.path, introduced)) findings.push(testDisabledFinding(change));
    }
    return findings;
  }
}

function removedLines(before: string, after: string): string[] {
  const afterCounts = new Map<string, number>();
  for (const line of splitLines(after)) afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);
  return splitLines(before).filter((line) => {
    const count = afterCounts.get(line) ?? 0;
    if (count === 0) return true;
    afterCounts.set(line, count - 1);
    return false;
  });
}

function splitLines(content: string): string[] {
  const values = content.split(/\r?\n/);
  if (values.at(-1) === "") values.pop();
  return values;
}

function hasAccessControlWeakening(path: string, removed: readonly string[], introduced: readonly string[]): boolean {
  const executableRemoved = removed.map(semanticCode).filter(Boolean);
  const executableIntroduced = introduced.map(semanticCode).filter(Boolean);
  return (executableRemoved.some((line) => AUTHORIZED.test(line)) && executableIntroduced.some((line) => ANONYMOUS.test(line)))
    || (executableRemoved.some((line) => ROUTE_WITH_GUARD.test(line)) && executableIntroduced.some((line) => ROUTE_WITHOUT_GUARD.test(line)))
    || (isJavaPath(path) && executableRemoved.some((line) => /@PreAuthorize\s*\(/.test(line)));
}

function hasAnonymousAccessIntroduced(change: FileChange, introduced: readonly string[]): boolean {
  return change.type === "created" && isSourcePath(change.path) && introduced.some((line) => ANONYMOUS.test(semanticCode(line)));
}

function isSourcePath(path: string): boolean {
  return /\.(?:cs|java|js|jsx|ts|tsx|py|go|kt|kts|php|rb|swift)$/i.test(path);
}

function criticalCommentOutEvidence(removed: readonly string[], introduced: readonly string[]): string | null {
  for (const line of removed) {
    const normalized = semanticCode(line).replace(/\s/g, "");
    if (!CRITICAL_RUNTIME.test(normalized)) continue;
    if (!introduced.some((candidate) => candidate.replace(/^\s*(?:\/\/|#)\s*/, "").replace(/\s/g, "") === normalized)) continue;
    return /usehttpsredirection/i.test(normalized)
      ? "HTTPS redirection call commented out"
      : "Critical executable call replaced with a comment";
  }
  return null;
}

function isBootstrapPath(path: string, before: string, after: string): boolean {
  const normalized = normalizePath(path);
  const basename = normalized.split("/").at(-1) ?? "";
  return BOOTSTRAP_BASENAME.test(basename)
    || IOS_BOOTSTRAP_BASENAME.test(basename)
    || BIN_ENTRYPOINT.test(normalized)
    || (/\.java$/i.test(basename) && JAVA_MAIN.test(`${before}\n${after}`));
}

function hasExecutableWiring(removed: readonly string[], introduced: readonly string[]): boolean {
  return [...removed, ...introduced]
    .map(semanticCode)
    .some((line) => BOOTSTRAP_WIRING.some((pattern) => pattern.test(line)));
}

function semanticCode(line: string): string {
  if (/^\s*\*/.test(line)) return "";
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    const next = line[index + 1] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) {
        result += character;
        quote = null;
      }
      continue;
    }
    if (character === "/" && (next === "/" || next === "*")) break;
    if (character === "#") break;
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += `${character}${character}`;
      continue;
    }
    result += character;
  }

  return result.trim();
}
function isJavaPath(path: string): boolean {
  return /\.java$/i.test(path);
}
function isTestPath(path: string): boolean {
  return /(?:\.(?:test|spec)\.[^.]+$|(?:^|\/)tests?\/|(?:^|\/)test[^/]*\.[^.]+$|_test\.(?:py|dart)$|Tests?\.(?:cs|java)$)/i.test(normalizePath(path));
}
function hasTestDisable(path: string, introduced: readonly string[]): boolean {
  return introduced.some((line) => {
    const code = semanticCode(line);
    return TEST_DISABLED.test(code) || (/\.dart$/i.test(path) && DART_TEST_DISABLED.test(code));
  });
}
function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function accessControlFinding(change: FileChange): Finding {
  return finding("high", "Access control weakened", "An existing protected surface appears to have been changed to permit unauthenticated access.", change, ["Authorization protection removed", "Anonymous access introduced"]);
}

function anonymousAccessFinding(change: FileChange): Finding {
  return finding("warning", "Anonymous access introduced", "A new surface explicitly permits unauthenticated access. Confirm that public exposure is intentional.", change, ["Explicit anonymous/public access introduced"]);
}

function disabledSecurityFinding(change: FileChange, evidence: string): Finding {
  return finding("high", "Security behavior disabled", "An existing security or runtime call appears to have been disabled by commenting it out.", change, [evidence]);
}

function bootstrapFinding(change: FileChange): Finding {
  return finding("warning", "Application bootstrap changed", "An application entrypoint received executable runtime wiring changes. Review startup and request-pipeline behavior.", change, ["Application entrypoint modified", "Executable runtime wiring changed"]);
}

function testDisabledFinding(change: FileChange): Finding {
  return finding("warning", "Tests may have been disabled", "A test was explicitly marked to skip or disable. Confirm that the coverage gap is intentional.", change, ["Explicit test-disable marker introduced"]);
}

function sensitiveFileFinding(change: FileChange): Finding {
  return finding("warning", "Sensitive file changed", "A sensitive credential or key-file path changed. Review the diff and ensure no credentials were introduced.", change, ["Sensitive path classification"], "sensitive-file");
}

function finding(severity: Finding["severity"], title: string, description: string, change: FileChange, evidence: string[], category: Finding["category"] = "semantic-risk"): Finding {
  return { severity, category, title, description, files: [change.path], evidence };
}
