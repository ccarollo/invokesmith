import { verifyPolicyIdentity, type InvokeSmithPolicy } from "../../policy/src/index.js";

export const AUTHZEN_EVALUATION_PATH = "/access/v1/evaluation" as const;

export interface AuthzenSubject {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}

export interface AuthzenAction {
  name: string;
  properties?: Record<string, unknown>;
}

export interface AuthzenResource {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}

export interface InvokeSmithEvaluationContext {
  environment?: string;
  caller?: { type: string; id: string };
  idempotencyKey?: string;
  confirmation?: {
    accepted: boolean;
    subjectId: string;
    actionId: string;
    resourceId: string;
    facts: string[];
  };
  policy?: { digest: string; releaseDigest: string };
}

export interface AccessEvaluationRequest {
  subject: AuthzenSubject;
  action: AuthzenAction;
  resource: AuthzenResource;
  context?: Record<string, unknown> & { invokesmith?: InvokeSmithEvaluationContext };
}

export type InvokeSmithDecision = "allow" | "deny" | "approval_required";

export interface AccessEvaluationResponse {
  decision: boolean;
  context: {
    invokesmith: {
      decision: InvokeSmithDecision;
      reason: string;
      policyDigest: string;
      releaseDigest: string;
    };
  };
}

export class AuthzenRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AuthzenRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAccessEvaluationRequest(value: unknown): AccessEvaluationRequest {
  if (!isRecord(value) || !isRecord(value.subject) || !isRecord(value.action) || !isRecord(value.resource)) {
    throw new AuthzenRequestError("CS-AUTHZEN-REQUEST-001", "subject, action, and resource objects are required.");
  }
  if (typeof value.subject.type !== "string" || typeof value.subject.id !== "string" ||
      typeof value.action.name !== "string" || typeof value.resource.type !== "string" || typeof value.resource.id !== "string") {
    throw new AuthzenRequestError("CS-AUTHZEN-REQUEST-001", "subject.type, subject.id, action.name, resource.type, and resource.id must be strings.");
  }
  if (value.subject.properties !== undefined && !isRecord(value.subject.properties)) {
    throw new AuthzenRequestError("CS-AUTHZEN-REQUEST-001", "subject.properties must be an object.");
  }
  if (value.action.properties !== undefined && !isRecord(value.action.properties)) {
    throw new AuthzenRequestError("CS-AUTHZEN-REQUEST-001", "action.properties must be an object.");
  }
  if (value.resource.properties !== undefined && !isRecord(value.resource.properties)) {
    throw new AuthzenRequestError("CS-AUTHZEN-REQUEST-001", "resource.properties must be an object.");
  }
  if (value.context !== undefined && !isRecord(value.context)) {
    throw new AuthzenRequestError("CS-AUTHZEN-REQUEST-001", "context must be an object.");
  }
  return value as unknown as AccessEvaluationRequest;
}

function response(policy: InvokeSmithPolicy, decision: InvokeSmithDecision, reason: string): AccessEvaluationResponse {
  return {
    decision: decision === "allow",
    context: {
      invokesmith: {
        decision,
        reason,
        policyDigest: policy.policyDigest,
        releaseDigest: policy.sources.release.digest
      }
    }
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function evaluateAccess(policy: InvokeSmithPolicy, input: AccessEvaluationRequest): AccessEvaluationResponse {
  const validity = verifyPolicyIdentity(policy);
  if (!validity.valid) return response(policy, "deny", "CS-AUTHZEN-POLICY-INVALID");
  if (input.action.name !== policy.action.id) return response(policy, "deny", "CS-AUTHZEN-ACTION-MISMATCH");
  if (input.subject.type !== policy.authorization.actor) return response(policy, "deny", "CS-AUTHZEN-ACTOR-MISMATCH");

  const subjectProperties = input.subject.properties ?? {};
  const resourceProperties = input.resource.properties ?? {};
  const scopes = strings(subjectProperties.scopes);
  if (!policy.authorization.scopes.every((scope) => scopes.includes(scope))) {
    return response(policy, "deny", "CS-AUTHZEN-SCOPE-MISSING");
  }
  if (typeof subjectProperties.tenantId !== "string" || subjectProperties.tenantId !== resourceProperties.tenantId) {
    return response(policy, "deny", "CS-AUTHZEN-TENANT-MISMATCH");
  }
  if (typeof resourceProperties.ownerId !== "string" || resourceProperties.ownerId !== input.subject.id) {
    return response(policy, "deny", "CS-AUTHZEN-RESOURCE-NOT-OWNED");
  }

  const extension = isRecord(input.context?.invokesmith) ? input.context.invokesmith as InvokeSmithEvaluationContext : {};
  if (typeof extension.environment !== "string" || !policy.authorization.environments.includes(extension.environment)) {
    return response(policy, "deny", "CS-AUTHZEN-ENVIRONMENT-NOT-ALLOWED");
  }

  if (policy.action.effect !== "read_only") {
    if (!extension.caller || extension.caller.type !== input.subject.type || extension.caller.id !== input.subject.id) {
      return response(policy, "deny", "CS-AUTHZEN-CALLER-MISMATCH");
    }
    const requiresIdempotency = policy.obligations.some((entry) => entry.id === "idempotency.key" && entry.required);
    if (requiresIdempotency && (typeof extension.idempotencyKey !== "string" || extension.idempotencyKey.length < 16)) {
      return response(policy, "deny", "CS-AUTHZEN-IDEMPOTENCY-REQUIRED");
    }
  }

  if (policy.confirmation.required) {
    const proof = extension.confirmation;
    if (!proof?.accepted) return response(policy, "approval_required", "CS-AUTHZEN-CONFIRMATION-REQUIRED");
    const facts = strings(proof.facts);
    if (proof.subjectId !== input.subject.id || proof.actionId !== input.action.name || proof.resourceId !== input.resource.id ||
        !policy.confirmation.facts.every((fact) => facts.includes(fact))) {
      return response(policy, "deny", "CS-AUTHZEN-CONFIRMATION-MISMATCH");
    }
  }
  return response(policy, "allow", "CS-AUTHZEN-ALLOW");
}

export function createAuthzenHandler(resolvePolicy: (request: AccessEvaluationRequest) => InvokeSmithPolicy | undefined | Promise<InvokeSmithPolicy | undefined>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id");
    const headers = requestId ? { "content-type": "text/plain; charset=utf-8", "x-request-id": requestId } : { "content-type": "text/plain; charset=utf-8" };
    const jsonHeaders = requestId ? { "x-request-id": requestId } : undefined;
    if (request.method !== "POST" || url.pathname !== AUTHZEN_EVALUATION_PATH) {
      return new Response("CS-AUTHZEN-NOT-FOUND: Use POST /access/v1/evaluation.", { status: 404, headers });
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return new Response("CS-AUTHZEN-CONTENT-TYPE-001: Content-Type must be application/json.", { status: 400, headers });
    }
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return new Response("CS-AUTHZEN-REQUEST-001: request body must be JSON.", { status: 400, headers });
    }
    let input: AccessEvaluationRequest;
    try {
      input = parseAccessEvaluationRequest(value);
    } catch (error) {
      const message = error instanceof AuthzenRequestError ? `${error.code}: ${error.message}` : "CS-AUTHZEN-REQUEST-001: invalid request.";
      return new Response(message, { status: 400, headers });
    }
    try {
      const policy = await resolvePolicy(input);
      if (!policy) return new Response("CS-AUTHZEN-POLICY-UNAVAILABLE: no local policy is available.", { status: 500, headers });
      return jsonHeaders
        ? Response.json(evaluateAccess(policy, input), { headers: jsonHeaders })
        : Response.json(evaluateAccess(policy, input));
    } catch {
      return new Response("CS-AUTHZEN-PDP-UNAVAILABLE: local decision service failed closed.", { status: 500, headers });
    }
  };
}
