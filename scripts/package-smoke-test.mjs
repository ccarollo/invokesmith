import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryProject = mkdtempSync(join(tmpdir(), "invokesmith-package-"));
const npmCache = join(temporaryProject, "npm-cache");
let tarballPath;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

try {
  run("bun", ["run", "build"]);
  const packResult = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts"]));
  const packed = packResult[0];
  if (!packed?.filename) throw new Error("npm pack did not return a tarball filename");

  tarballPath = join(repositoryRoot, packed.filename);
  const packagedFiles = new Set(packed.files.map((entry) => entry.path));
  for (const required of [
    "dist/invokesmith.js",
    "assets/invokesmith-mark.svg",
    "README.md",
    "LICENSE",
    "NOTICE",
    "package.json"
  ]) {
    if (!packagedFiles.has(required)) throw new Error(`package is missing ${required}`);
  }

  const forbidden = [...packagedFiles].find((path) =>
    path.startsWith("packages/") ||
    path.startsWith("tests/") ||
    path.startsWith(".github/") ||
    path.startsWith(".invokesmith/")
  );
  if (forbidden) throw new Error(`package unexpectedly contains ${forbidden}`);

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: temporaryProject
  });

  const installedManifest = JSON.parse(
    readFileSync(join(temporaryProject, "node_modules", "invokesmith", "package.json"), "utf8")
  );
  const cliPath = join(temporaryProject, "node_modules", "invokesmith", "dist", "invokesmith.js");
  const version = execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" }).trim();
  if (version !== installedManifest.version) {
    throw new Error(`CLI version ${version} does not match package version ${installedManifest.version}`);
  }

  const exampleContract = join(repositoryRoot, "examples", "smithtasks", "reschedule-task.json");
  const validation = execFileSync(process.execPath, [cliPath, "validate", exampleContract], {
    encoding: "utf8"
  });
  if (!validation.startsWith("PASS ")) throw new Error("installed CLI could not validate the example contract");

  process.stdout.write(
    `PASS invokesmith@${version} installs without runtime dependencies and validates a contract (${packed.size} byte tarball)\n`
  );
} finally {
  rmSync(temporaryProject, { recursive: true, force: true });
  if (tarballPath) rmSync(tarballPath, { force: true });
}
