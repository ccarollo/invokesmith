import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createSmithTasksFixture,
  InMemoryStateStore,
  JsonFileStateStore,
  SmithTasksError,
  SmithTasksService,
  type InvocationContext,
  type Principal,
  type SmithTasksState
} from "../packages/smithtasks-runtime/src/index.js";

const digest = "sha256:test-contract";
const fullPrincipal: Principal = { id: "user-123", actor: "user", scopes: ["tasks:read", "tasks:write", "tasks:delete"], tenantId: "tenant-demo" };
const context = (principal: Principal = fullPrincipal, confirmationAccepted = true): InvocationContext => ({ principal, contractDigest: digest, confirmationAccepted });

function memoryService(): { service: SmithTasksService; store: InMemoryStateStore } {
  const store = new InMemoryStateStore(createSmithTasksFixture());
  return { service: new SmithTasksService(store, () => new Date("2026-09-09T15:00:00Z")), store };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SmithTasksError);
    expect((error as SmithTasksError).code).toBe(code);
  }
}

describe("SmithTasks runtime authorization and visibility", () => {
  test("requires the action scope and user actor", async () => {
    const { service } = memoryService();
    await expectCode(service.search({ query: "roadmap" }, context({ id: "user-123", actor: "user", scopes: [], tenantId: "tenant-demo" })), "NOT_AUTHORIZED");
    await expectCode(service.search({ query: "roadmap" }, context({ id: "user-123", actor: "agent", scopes: ["tasks:read"], tenantId: "tenant-demo" })), "ACTOR_NOT_ALLOWED");
  });

  test("returns only tasks visible to the acting user", async () => {
    const { service, store } = memoryService();
    const result = await service.search({ query: "roadmap", dueBefore: "2026-09-11T00:00:00Z" }, context());
    expect((result.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual(["task-123"]);
    expect((await store.snapshot()).audit).toEqual([]);
  });
});

describe("SmithTasks state, idempotency, and evidence", () => {
  test("reschedules once and returns the original receipt on retry", async () => {
    const { service, store } = memoryService();
    const input = { taskId: "task-123", dueAt: "2026-09-15T09:00:00-05:00", timeZone: "America/Chicago", idempotencyKey: "01J7INVOKESMITHDEMO" };
    const first = await service.reschedule(input, context());
    const second = await service.reschedule({ ...input }, context());
    const state = await store.snapshot();
    expect(second).toEqual(first);
    expect(state.tasks["task-123"]?.dueAt).toBe(input.dueAt);
    expect(state.tasks["task-123"]?.timeZone).toBe(input.timeZone);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]?.contractDigest).toBe(digest);
    await expectCode(service.reschedule({ ...input, dueAt: "2027-01-01T00:00:00Z" }, context()), "IDEMPOTENCY_KEY_REUSED");
  });

  test("refuses unconfirmed deletion, then records a recoverable deletion once", async () => {
    const { service, store } = memoryService();
    const input = { taskId: "task-123", idempotencyKey: "01J7DELETEDEMO00" };
    await expectCode(service.delete(input, context(fullPrincipal, false)), "CONFIRMATION_REQUIRED");
    expect((await store.snapshot()).tasks["task-123"]?.status).toBe("active");
    const first = await service.delete(input, context());
    const second = await service.delete(input, context());
    const state = await store.snapshot();
    expect(second).toEqual(first);
    expect(state.tasks["task-123"]?.status).toBe("trash");
    expect(state.tasks["task-123"]?.recoverableUntil).toBe("2026-10-09T15:00:00.000Z");
    expect(state.audit).toHaveLength(1);
    expect(first.auditReceipt).toBe("smithtasks-audit-00000001");
  });

  test("persists mutations, idempotency records, and audit events to disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithtasks-state-"));
    const path = join(root, "state.json");
    const input = { taskId: "task-123", dueAt: "2026-10-01T10:00:00Z", timeZone: "UTC", idempotencyKey: "persistent-key-001" };
    const first = new SmithTasksService(new JsonFileStateStore(path, createSmithTasksFixture()), () => new Date("2026-09-09T15:00:00Z"));
    const response = await first.reschedule(input, context());
    const reopened = new SmithTasksService(new JsonFileStateStore(path, createSmithTasksFixture()), () => new Date("2026-09-10T15:00:00Z"));
    expect(await reopened.reschedule(input, context())).toEqual(response);
    const state = JSON.parse(await readFile(path, "utf8")) as SmithTasksState;
    expect(state.audit).toHaveLength(1);
    expect(Object.keys(state.idempotency)).toEqual(["persistent-key-001"]);
  });
});

test("the real generated stdio server executes all three application handlers", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithtasks-mcp-"));
  const statePath = join(root, "state.json");
  const projectRoot = new URL("../generated/smithtasks-mcp/", import.meta.url).pathname;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "./src/server.ts"],
    cwd: projectRoot,
    env: {
      ...getDefaultEnvironment(),
      INVOKESMITH_ACTOR_ID: "user-123",
      INVOKESMITH_ACTOR_TYPE: "user",
      INVOKESMITH_SCOPES: "tasks:read tasks:write tasks:delete",
      INVOKESMITH_SMITH_TASKS_STATE: statePath
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "invokesmith-outcome-observation", version: "0.1.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { confirm: true } }));
  try {
    await client.connect(transport);
    const search = await client.callTool({ name: "dev.smithtasks.tasks.search", arguments: { query: "roadmap" } });
    expect(((search.structuredContent as { tasks: Array<{ id: string }> }).tasks).map((task) => task.id)).toEqual(["task-123"]);
    const reschedule = await client.callTool({ name: "dev.smithtasks.tasks.reschedule", arguments: { taskId: "task-123", dueAt: "2026-09-15T09:00:00-05:00", timeZone: "America/Chicago", idempotencyKey: "stdio-reschedule-001" } });
    expect((reschedule.structuredContent as { dueAt: string }).dueAt).toBe("2026-09-15T09:00:00-05:00");
    const deletion = await client.callTool({ name: "dev.smithtasks.tasks.delete", arguments: { taskId: "task-123", idempotencyKey: "stdio-delete-key-01" } });
    expect((deletion.structuredContent as { auditReceipt: string }).auditReceipt).toBe("smithtasks-audit-00000002");
  } finally {
    await client.close();
  }
  const state = JSON.parse(await readFile(statePath, "utf8")) as SmithTasksState;
  expect(state.tasks["task-123"]?.status).toBe("trash");
  expect(state.audit.map((event) => event.actionId)).toEqual(["dev.smithtasks.tasks.reschedule", "dev.smithtasks.tasks.delete"]);
});

test("the generated server cannot bypass a missing application scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithtasks-mcp-denied-"));
  const statePath = join(root, "state.json");
  const projectRoot = new URL("../generated/smithtasks-mcp/", import.meta.url).pathname;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "./src/server.ts"],
    cwd: projectRoot,
    env: {
      ...getDefaultEnvironment(),
      INVOKESMITH_ACTOR_ID: "user-123",
      INVOKESMITH_ACTOR_TYPE: "user",
      INVOKESMITH_SCOPES: "tasks:read",
      INVOKESMITH_SMITH_TASKS_STATE: statePath
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "invokesmith-denied", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "dev.smithtasks.tasks.reschedule", arguments: { taskId: "task-123", dueAt: "2026-09-15T09:00:00-05:00", timeZone: "America/Chicago", idempotencyKey: "denied-reschedule-01" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("tasks:write");
  } finally {
    await client.close();
  }
});
