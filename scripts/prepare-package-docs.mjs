import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = process.cwd();
const repositoryRoot = resolve(packageRoot, "../..");

await Promise.all([
  copyFile(resolve(repositoryRoot, "LICENSE"), resolve(packageRoot, "LICENSE")),
  copyFile(resolve(repositoryRoot, "README.md"), resolve(packageRoot, "README.md")),
]);
