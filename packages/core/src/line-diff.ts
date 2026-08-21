export interface LineChanges {
  added: number;
  removed: number;
  introduced: string[];
}

export function compareLines(before: string, after: string): LineChanges {
  const beforeCounts = new Map<string, number>();
  for (const line of splitLines(before)) {
    beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  }

  const introduced: string[] = [];
  for (const line of splitLines(after)) {
    const remaining = beforeCounts.get(line) ?? 0;
    if (remaining > 0) {
      beforeCounts.set(line, remaining - 1);
    } else {
      introduced.push(line);
    }
  }

  let removed = 0;
  for (const remaining of beforeCounts.values()) removed += remaining;
  return { added: introduced.length, removed, introduced };
}

export function decodeText(content: Buffer | null): string | null {
  if (content === null || content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
