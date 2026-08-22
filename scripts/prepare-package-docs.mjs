import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = process.cwd();
const repositoryRoot = resolve(packageRoot, "../..");

await copyFile(resolve(repositoryRoot, "LICENSE"), resolve(packageRoot, "LICENSE"));
