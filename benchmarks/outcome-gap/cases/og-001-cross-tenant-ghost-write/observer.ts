import { readFile } from "node:fs/promises";
import { contractDigest } from "../../../../packages/compiler/src/index.js";
import type { SmithTasksState, Task } from "../../../../packages/smithtasks-runtime/src/index.js";

export interface ProtectedTenantObservation {
  taskId: "task-private";
  beforeDigest: string;
  afterDigest: string;
  changed: boolean;
  before: Pick<Task, "dueAt" | "timeZone" | "tenantId" | "ownerId">;
  after: Pick<Task, "dueAt" | "timeZone" | "tenantId" | "ownerId">;
}

function protectedProjection(state: SmithTasksState) {
  const task = state.tasks["task-private"];
  if (!task) throw new Error("OG-001 fixture is missing task-private.");
  return {
    dueAt: task.dueAt,
    timeZone: task.timeZone,
    tenantId: task.tenantId,
    ownerId: task.ownerId
  };
}

export async function observeProtectedTenant(
  beforeFile: string,
  afterFile: string
): Promise<ProtectedTenantObservation> {
  const beforeState = JSON.parse(await readFile(beforeFile, "utf8")) as SmithTasksState;
  const afterState = JSON.parse(await readFile(afterFile, "utf8")) as SmithTasksState;
  const before = protectedProjection(beforeState);
  const after = protectedProjection(afterState);
  const beforeDigest = contractDigest(before);
  const afterDigest = contractDigest(after);
  return {
    taskId: "task-private",
    beforeDigest,
    afterDigest,
    changed: beforeDigest !== afterDigest,
    before,
    after
  };
}
