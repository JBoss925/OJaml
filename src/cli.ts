import { readFile } from "node:fs/promises";
import { compile } from "./compiler";
import { formatOJamlError } from "./errors";
import { runOJaml } from "./runtime";

const file = process.argv[2];
const shouldRun = process.argv.includes("--run");

if (!file) {
  console.error("Usage: npm run cli <file.oj> [--run]");
  process.exit(1);
}

const source = await readFile(file, "utf8");

try {
  if (shouldRun) {
    const result = await runOJaml(source, {
      onPrint(value) {
        console.log(value);
      },
    });
    console.log(result.mainType === "unit" ? "()" : result.value);
  } else {
    console.log(compile(source).wat);
  }
} catch (error) {
  console.error(formatOJamlError(source, error));
  process.exit(1);
}
