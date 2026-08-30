import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCliVersion,
  validatePackedNpmArtifact,
  validateVsixArtifact,
} from "./release-integrity.mjs";

const npmPackage = {
  name: "@agentcheck/fixture",
  version: "1.2.3",
  main: "dist/index.js",
  types: "dist/index.d.ts",
  exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
  bin: { agentcheck: "dist/index.js" },
  files: ["dist"],
};

test("historical missing CLI bin fixture fails with an actionable packed-artifact diagnostic", () => {
  const cliPackage = {
    name: "@agentcheck/cli-fixture",
    version: "0.1.4",
    bin: { agentcheck: "dist/index.js" },
    files: ["dist"],
  };
  assert.throws(
    () => validatePackedNpmArtifact(cliPackage, ["package.json", "README.md", "LICENSE"]),
    /bin\.agentcheck `dist\/index\.js` is missing from packed artifact/,
  );
});

test("missing declared package entrypoint fails", () => {
  assert.throws(
    () => validatePackedNpmArtifact({ ...npmPackage, bin: {} }, ["package.json", "README.md", "LICENSE", "dist/index.d.ts"]),
    /declared main `dist\/index\.js` is missing/,
  );
});

test("CLI version mismatch fails", () => {
  assert.throws(() => validateCliVersion(npmPackage, "9.9.9"), /agentcheck --version returned `9\.9\.9`/);
});

test("missing VSIX extension main fails", () => {
  const extension = {
    name: "agentcheck-vscode",
    version: "1.2.3",
    main: "./dist/extension.cjs",
    icon: "media/icon.png",
    vsce: { dependencies: false },
    contributes: { commands: [{ command: "agentcheck.review" }], viewsContainers: { activitybar: [{ icon: "media/shield.svg" }] } },
  };
  assert.throws(
    () => validateVsixArtifact(extension, ["extension/package.json", "extension/README.md", "extension/LICENSE", "extension/media/icon.png", "extension/media/shield.svg"]),
    /declared extension main `dist\/extension\.cjs` is missing/,
  );
});

test("valid package and VSIX artifacts pass, including Windows-style paths", () => {
  const files = ["package.json", "README.md", "LICENSE", "dist\\index.js", "dist/index.d.ts"];
  assert.deepEqual(validatePackedNpmArtifact(npmPackage, files), new Set(["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]));
  assert.doesNotThrow(() => validateCliVersion(npmPackage, "1.2.3"));
  assert.doesNotThrow(() => validateVsixArtifact({
    name: "agentcheck-vscode",
    version: "1.2.3",
    main: "dist/extension.cjs",
    icon: "media/icon.png",
    vsce: { dependencies: false },
    contributes: { commands: [{ command: "agentcheck.review" }], viewsContainers: { activitybar: [{ icon: "media/shield.svg" }] } },
  }, ["extension/package.json", "extension/README.md", "extension/LICENSE", "extension/dist/extension.cjs", "extension/media/icon.png", "extension/media/shield.svg"]));
});
