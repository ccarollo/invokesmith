import { createHash } from "node:crypto";
import type { StateStore } from "./store.js";
import type {
  AuditEvent,
  DeleteTaskInput,
  InvocationContext,
  Principal,
  RescheduleTaskInput,
  SearchTasksInput,
  SmithTasksState,
  Task
} from "./types.js";

export class SmithTasksError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SmithTasksError";
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
}

function fingerprint(input: unknown): string {
  return createHash("sha256").update(stable(input)).digest("hex");
}

function requireScope(principal: Principal, scope: string): void {
  if (principal.actor !== "user") throw new SmithTasksError("ACTOR_NOT_ALLOWED", "SmithTasks reference actions require a user actor.");
  if (!principal.scopes.includes(scope)) throw new SmithTasksError("NOT_AUTHORIZED", `The acting user is missing the ${scope} scope.`);
}

function visibleTask(state: SmithTasksState, taskId: string, principal: Principal): Task {
  const task = state.tasks[taskId];
  if (!task || task.ownerId !== principal.id || task.tenantId !== principal.tenantId) throw new SmithTasksError("TASK_NOT_FOUND", "The task does not exist or is not visible in this tenant.");
  return task;
}

function audit(state: SmithTasksState, context: InvocationContext, actionId: string, taskId: string, changes: Record<string, unknown>, now: string): AuditEvent {
  const sequence = state.nextAuditSequence++;
  const event: AuditEvent = {
    sequence,
    receipt: `smithtasks-audit-${sequence.toString().padStart(8, "0")}`,
    occurredAt: now,
    actorId: context.principal.id,
    actorType: context.principal.actor,
    actionId,
    contractDigest: context.contractDigest,
    taskId,
    outcome: "success",
    changes
  };
  state.audit.push(event);
  return event;
}

export class SmithTasksService {
  constructor(private readonly store: StateStore, private readonly now: () => Date = () => new Date()) {}

  async search(input: SearchTasksInput, context: InvocationContext): Promise<Record<string, unknown>> {
    requireScope(context.principal, "tasks:read");
    const query = input.query.trim().toLowerCase();
    if (!query) throw new SmithTasksError("INVALID_QUERY", "query must not be empty.");
    const state = await this.store.snapshot();
    const dueBefore = input.dueBefore ? Date.parse(input.dueBefore) : undefined;
    const tasks = Object.values(state.tasks)
      .filter((task) => task.ownerId === context.principal.id && task.tenantId === context.principal.tenantId && task.status === "active")
      .filter((task) => task.title.toLowerCase().includes(query))
      .filter((task) => !input.projectId || task.projectId === input.projectId)
      .filter((task) => dueBefore === undefined || (task.dueAt !== null && Date.parse(task.dueAt) < dueBefore))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((task) => ({ id: task.id, title: task.title, projectId: task.projectId, dueAt: task.dueAt, timeZone: task.timeZone }));
    return { tasks, nextCursor: null };
  }

  async reschedule(input: RescheduleTaskInput, context: InvocationContext): Promise<Record<string, unknown>> {
    requireScope(context.principal, "tasks:write");
    return this.mutateIdempotently("dev.smithtasks.tasks.reschedule", input.idempotencyKey, input, async (state) => {
      const task = visibleTask(state, input.taskId, context.principal);
      if (task.status !== "active") throw new SmithTasksError("TASK_NOT_FOUND", "The task does not exist or is not visible.");
      const previousDueAt = task.dueAt;
      const previousTimeZone = task.timeZone;
      task.dueAt = input.dueAt;
      task.timeZone = input.timeZone;
      const event = audit(state, context, "dev.smithtasks.tasks.reschedule", task.id, { previousDueAt, previousTimeZone, dueAt: task.dueAt, timeZone: task.timeZone }, this.now().toISOString());
      return { taskId: task.id, previousDueAt, dueAt: task.dueAt, auditReceipt: event.receipt };
    });
  }

  async delete(input: DeleteTaskInput, context: InvocationContext): Promise<Record<string, unknown>> {
    requireScope(context.principal, "tasks:delete");
    if (!context.confirmationAccepted) throw new SmithTasksError("CONFIRMATION_REQUIRED", "The destructive delete action requires informed confirmation.");
    return this.mutateIdempotently("dev.smithtasks.tasks.delete", input.idempotencyKey, input, async (state) => {
      const task = visibleTask(state, input.taskId, context.principal);
      if (task.status === "trash") throw new SmithTasksError("TASK_ALREADY_DELETED", "The task is already in trash.");
      const deletedAt = this.now();
      const recoverableUntil = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      task.status = "trash";
      task.trashedAt = deletedAt.toISOString();
      task.recoverableUntil = recoverableUntil.toISOString();
      const event = audit(state, context, "dev.smithtasks.tasks.delete", task.id, { status: "trash", recoverableUntil: task.recoverableUntil }, deletedAt.toISOString());
      return { taskId: task.id, deletedAt: task.trashedAt, recoverableUntil: task.recoverableUntil, auditReceipt: event.receipt };
    });
  }

  private async mutateIdempotently(
    actionId: string,
    key: string,
    input: unknown,
    operation: (state: SmithTasksState) => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    if (key.length < 16) throw new SmithTasksError("INVALID_IDEMPOTENCY_KEY", "The idempotency key must contain at least 16 characters.");
    const inputFingerprint = fingerprint(input);
    return this.store.transact(async (state) => {
      const existing = state.idempotency[key];
      if (existing) {
        if (existing.actionId !== actionId || existing.fingerprint !== inputFingerprint) throw new SmithTasksError("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used for a different request.");
        return existing.response;
      }
      const response = await operation(state);
      state.idempotency[key] = { actionId, fingerprint: inputFingerprint, response, auditReceipt: String(response.auditReceipt) };
      return response;
    });
  }
}
