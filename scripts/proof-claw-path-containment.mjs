import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";
import { parseAllDocuments } from "yaml";

const packageJson = JSON.parse(readFileSync("node_modules/@openclaw/fs-safe/package.json", "utf8"));
const sourcePath = "node_modules/@openclaw/fs-safe/dist/path.js";
const typesPath = "node_modules/@openclaw/fs-safe/dist/path.d.ts";
const source = readFileSync(sourcePath, "utf8");
const types = readFileSync(typesPath, "utf8");
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = parseAllDocuments(readFileSync("pnpm-lock.yaml", "utf8"))
  .map((document) => document.toJS())
  .find((document) => document.importers?.["."]?.dependencies?.["@openclaw/fs-safe"]);

assert.equal(process.platform, "win32");
assert.equal(packageJson.version, "0.5.6");
assert.equal(rootPackage.dependencies["@openclaw/fs-safe"], "0.5.6");
assert.deepEqual(lockfile.importers["."].dependencies["@openclaw/fs-safe"], {
  specifier: "0.5.6",
  version: "0.5.6",
});
assert.match(source, /relativePath === "\.\."/);
assert.match(source, /relativePath\.startsWith\(`\.\.\$\{path\.sep\}`\)/);
assert.match(source, /path\.isAbsolute\(relativePath\)/);
assert.match(types, /isPathRelativeEscape\(relativePath: string\): boolean/);

console.log(`platform=${process.platform}`);
console.log(`fs-safe-version=${packageJson.version}`);
console.log(`fs-safe-source=${source.match(/return relativePath[^;]+;/)[0]}`);
console.log(
  `fs-safe-types=${types.match(/export declare function isPathRelativeEscape[^;]+;/)[0]}`,
);

for (const [name, root, target] of [
  ["cross-drive", "C:\\root", "D:\\root\\file.md"],
  ["cross-UNC", "\\\\server\\share\\root", "\\\\other\\share\\root\\file.md"],
]) {
  const child = win32.relative(root, target);
  assert.equal(win32.isAbsolute(child), true);
  assert.equal(isPathRelativeEscape(child), true);
  console.log(`${name}-relative=${JSON.stringify(child)} absolute=true escape=true`);
}

function runTests(files) {
  return spawnSync(process.execPath, ["scripts/run-vitest.mjs", "run", ...files], {
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
  }).status;
}

assert.equal(runTests(["src/claws/path-containment.test.ts"]), 0);

const absoluteClause = " || path.isAbsolute(relativePath)";
assert.ok(source.includes(absoluteClause));
writeFileSync(sourcePath, source.replace(absoluteClause, ""));
try {
  assert.notEqual(runTests(["src/claws/path-containment.test.ts"]), 0);
  console.log("windows-absolute-result-mutation=expected-failure");
} finally {
  writeFileSync(sourcePath, source);
}
assert.equal(runTests(["src/claws/path-containment.test.ts"]), 0);
console.log("windows-path-containment-proof=passed");
