import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./src/extension.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/extension.cjs", import.meta.url)),
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
});
await build({
  entryPoints: [fileURLToPath(new URL("./src/extension-host-test.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/extension-host-test.cjs", import.meta.url)),
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
});
await copyFile(new URL("../../LICENSE", import.meta.url), new URL("./LICENSE", import.meta.url));
