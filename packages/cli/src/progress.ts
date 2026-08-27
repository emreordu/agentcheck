import type { PresentationOptions } from "./presentation.ts";

interface ProgressStream {
  readonly isTTY?: boolean;
  write(message: string): boolean;
}

export interface Progress {
  stop(): void;
}

const FRAMES = ["◐", "◓", "◑", "◒"];
const START_DELAY_MS = 100;
const FRAME_INTERVAL_MS = 80;

export function createProgress(stream: ProgressStream, message: string, options: PresentationOptions): Progress {
  if (!options.interactive || !stream.isTTY) return { stop() {} };

  let frame = 0;
  let visible = false;
  let interval: NodeJS.Timeout | undefined;
  const delay = setTimeout(() => {
    visible = true;
    render();
    interval = setInterval(render, FRAME_INTERVAL_MS);
  }, START_DELAY_MS);

  function render(): void {
    const glyph = color(FRAMES[frame] ?? FRAMES[0]!, options);
    stream.write("\r\u001B[2K" + glyph + " " + color(message, options));
    frame = (frame + 1) % FRAMES.length;
  }

  return {
    stop(): void {
      clearTimeout(delay);
      if (interval) clearInterval(interval);
      if (visible) stream.write("\r\u001B[2K");
    },
  };
}

function color(value: string, options: PresentationOptions): string {
  return options.color ? "\u001B[36m" + value + "\u001B[0m" : value;
}
