import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const actionId = "dev.smithtasks.tasks.reschedule";

export interface BaselineResult {
  status: "passed";
  checks: string[];
  response: Record<string, unknown>;
}

export async function runResponseAndTraceBaseline(
  serverDirectory: string,
  stateFile: string
): Promise<BaselineResult> {
  const transport = new StdioClientTransport({
    command: process.env.INVOKESMITH_BUN_BIN ?? "bun",
    args: ["run", "./src/server.ts"],
    cwd: serverDirectory,
    env: {
      ...getDefaultEnvironment(),
      INVOKESMITH_ACTOR_ID: "user-123",
      INVOKESMITH_ACTOR_TYPE: "user",
      INVOKESMITH_TENANT_ID: "tenant-demo",
      INVOKESMITH_SCOPES: "tasks:write",
      INVOKESMITH_SMITH_TASKS_STATE: stateFile
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "outcome-gap-baseline", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === actionId);
    if (!tool) throw new Error(`Baseline could not discover ${actionId}.`);
    const result = await client.callTool({
      name: actionId,
      arguments: {
        taskId: "task-123",
        dueAt: "2026-09-15T09:00:00-05:00",
        timeZone: "America/Chicago",
        idempotencyKey: "01J7OUTCOMEGAP0001"
      }
    });
    if (result.isError) throw new Error("Baseline expected a successful MCP response.");
    const response = result.structuredContent;
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Baseline expected structured response content.");
    }
    if (response.taskId !== "task-123" || response.dueAt !== "2026-09-15T09:00:00-05:00") {
      throw new Error("Baseline response did not describe the requested task update.");
    }
    if (typeof response.auditReceipt !== "string") throw new Error("Baseline response lacked an audit receipt.");
    return {
      status: "passed",
      checks: ["tool discovered", "single tool call succeeded", "response schema accepted", "intended task and due date returned", "audit receipt returned"],
      response
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
