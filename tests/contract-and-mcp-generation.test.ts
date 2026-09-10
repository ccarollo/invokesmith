import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionContract } from "../packages/contract/src/index.js";
import { lowerActionContract, validateActionContract } from "../packages/compiler/src/index.js";
import { writeGenerationPlan } from "../packages/cli/src/write-plan.js";
import { mcpTargetPlugin } from "../plugins/target-mcp/src/index.js";

async function loadAction(name: string): Promise<ActionContract> {
  const input = JSON.parse(await readFile(new URL(`../examples/smithtasks/${name}.json`, import.meta.url), "utf8")) as unknown;
  const result = validateActionContract(input);
  if (!result.valid || !result.value) throw new Error(`${name} reference action is invalid`);
  return result.value;
}

describe("intermediate representation", () => {
  test("normalizes unordered semantics without changing schemas", async () => {
    const contract = await loadAction("delete-task");
    contract.spec.confirmation.facts = ["task.title", "recoveryWindow", "task.project"];
    const ir = lowerActionContract(contract);
    expect(ir.irVersion).toBe("invokesmith.ir/v0alpha1");
    expect(ir.confirmation.facts).toEqual(["recoveryWindow", "task.project", "task.title"]);
    expect(ir.inputSchema).toEqual(contract.spec.input);
    expect(ir.effects.mutating).toBe(true);
  });
});

describe("MCP target plugin", () => {
  test("is deterministic and reports semantic compromises", async () => {
    const actions = await Promise.all(["search-tasks", "reschedule-task", "delete-task"].map(async (name) => lowerActionContract(await loadAction(name))));
    const first = mcpTargetPlugin.generate(actions);
    const second = mcpTargetPlugin.generate([...actions].reverse());
    expect(second).toEqual(first);
    expect(first.files.find((file) => file.path === "src/server.ts")?.contents).toContain("server.registerTool");
    expect(first.findings.some((finding) => finding.code === "MCP-AUTH-RUNTIME")).toBe(true);
    expect(first.findings.some((finding) => finding.support === "unrepresentable")).toBe(false);
  });

  test("preserves custom handlers while updating managed output", async () => {
    const action = lowerActionContract(await loadAction("search-tasks"));
    const plan = mcpTargetPlugin.generate([action]);
    const root = await mkdtemp(join(tmpdir(), "invokesmith-writer-"));
    const initial = await writeGenerationPlan(plan, root);
    const handler = plan.files.find((file) => file.ownership === "custom")!;
    const handlerPath = join(root, handler.path);
    await writeFile(handlerPath, "// customer implementation\n", "utf8");
    const second = await writeGenerationPlan(plan, root);
    expect(initial.find((entry) => entry.path === handler.path)?.status).toBe("created");
    expect(second.find((entry) => entry.path === handler.path)?.status).toBe("preserved");
    expect(await readFile(handlerPath, "utf8")).toBe("// customer implementation\n");
    expect(second.filter((entry) => entry.ownership === "managed").every((entry) => entry.status === "unchanged")).toBe(true);
  });
});
