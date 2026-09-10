import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "packages/cli/src/index.ts");
const contracts = ["search-tasks", "reschedule-task", "delete-task"].map((name) => join(root, `examples/smithtasks/${name}.json`));

async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([Bun.which("bun")!, "run", cli, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  return { exitCode, stdout, stderr };
}

describe("outcome CLI", () => {
  test("compiles inspectable scenario plans in machine-readable form", async () => {
    const result = await run(["scenario", "compile", contracts[0]!, "--json"]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      apiVersion: "invokesmith.test-plan/v0alpha1",
      scenario: { id: "find-overdue-roadmap-task" },
      variant: "contract"
    });
  });

  test("runs the complete outcome suite and preserves verifiable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invokesmith-cli-test-"));
    const evidenceFile = join(directory, "evidence.json");
    try {
      const result = await run([
        "test", "--outcome",
        "--server", join(root, "generated/smithtasks-mcp"),
        "--evidence", evidenceFile,
        "--json",
        ...contracts
      ]);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toMatchObject({ status: "passed", runCount: 9, evidence: { path: evidenceFile } });
      const evidence = JSON.parse(await readFile(evidenceFile, "utf8")) as Record<string, unknown>;
      expect(evidence).toMatchObject({ apiVersion: "invokesmith.evidence-manifest/v0alpha1", suite: { resultCount: 9 } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const defectCases = [
    ["wrong-response", 1, "assertion"],
    ["wrong-state", 1, "assertion"],
    ["wrong-tenant", 1, "assertion"],
    ["extra-mutation", 1, "assertion"],
    ["missing-audit", 1, "assertion"],
    ["provider-failure", 3, "provider"]
  ] as const;

  for (const [defect, exitCode, failureClass] of defectCases) {
    test(`reproduces the ${defect} defect with a stable exit`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "invokesmith-defect-test-"));
      try {
        const result = await run([
          "test", "--outcome",
          "--server", join(root, "generated/smithtasks-mcp"),
          "--evidence", join(directory, "evidence.json"),
          "--demo-defect", defect,
          "--json",
          ...contracts
        ]);
        expect(result.exitCode).toBe(exitCode);
        const output = JSON.parse(result.stdout) as { results: Array<{ failureClass?: string }> };
        expect(output.results.some((entry) => entry.failureClass === failureClass)).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 15_000);
  }

  test("runs the bundled flagship outcome command under Node and reserves exit 2 for invalid configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invokesmith-node-cli-"));
    const bundle = join(directory, "invokesmith.js");
    try {
      const build = Bun.spawn([Bun.which("bun")!, "build", cli, "--target=node", `--outfile=${bundle}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(await build.exited).toBe(0);
      const process = Bun.spawn([
        Bun.which("node")!, bundle,
        "test", "--outcome",
        "--server", join(root, "generated/smithtasks-mcp"),
        "--evidence", join(directory, "evidence.json"),
        "--json",
        ...contracts
      ], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ status: "passed", runCount: 9 });

      const invalid = await run(["test", "--outcome"]);
      expect(invalid.exitCode).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
