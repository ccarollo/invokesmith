export type ActorType = "user" | "service" | "agent";

export interface Principal {
  id: string;
  actor: ActorType;
  scopes: string[];
  tenantId: string;
}

export interface Task {
  id: string;
  title: string;
  projectId: string;
  ownerId: string;
  tenantId: string;
  dueAt: string | null;
  timeZone: string;
  status: "active" | "trash";
  trashedAt?: string;
  recoverableUntil?: string;
}

export interface AuditEvent {
  sequence: number;
  receipt: string;
  occurredAt: string;
  actorId: string;
  actorType: ActorType;
  actionId: string;
  contractDigest: string;
  taskId: string;
  outcome: "success";
  changes: Record<string, unknown>;
}

export interface IdempotencyRecord {
  actionId: string;
  fingerprint: string;
  response: Record<string, unknown>;
  auditReceipt: string;
}

export interface SmithTasksState {
  version: 1;
  tasks: Record<string, Task>;
  idempotency: Record<string, IdempotencyRecord>;
  audit: AuditEvent[];
  nextAuditSequence: number;
}

export interface InvocationContext {
  principal: Principal;
  contractDigest: string;
  confirmationAccepted: boolean;
}

export interface SearchTasksInput {
  query: string;
  projectId?: string;
  dueBefore?: string;
  cursor?: string;
}

export interface RescheduleTaskInput {
  taskId: string;
  dueAt: string;
  timeZone: string;
  recurrenceMode?: "this_occurrence" | "this_and_future";
  idempotencyKey: string;
}

export interface DeleteTaskInput {
  taskId: string;
  idempotencyKey: string;
}
