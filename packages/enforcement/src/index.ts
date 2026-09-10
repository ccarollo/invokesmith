import {
  evaluateAccess,
  parseAccessEvaluationRequest,
  type AccessEvaluationRequest,
  type AccessEvaluationResponse
} from "../../authzen/src/index.js";
import type { InvokeSmithPolicy } from "../../policy/src/index.js";
import { assessPolicyStatus, type PolicyStatusOptions } from "../../policy-status/src/index.js";
import type { SignedArtifact } from "../../signing/src/index.js";
import {
  SmithTasksError,
  type DeleteTaskInput,
  type Principal,
  type RescheduleTaskInput,
  type SearchTasksInput,
  type SmithTasksService
} from "../../smithtasks-runtime/src/index.js";

export interface PolicyDecisionClient {
  evaluate(policy: InvokeSmithPolicy, request: AccessEvaluationRequest): Promise<AccessEvaluationResponse>;
}

export class LocalPolicyDecisionClient implements PolicyDecisionClient {
  async evaluate(policy: InvokeSmithPolicy, request: AccessEvaluationRequest): Promise<AccessEvaluationResponse> {
    return evaluateAccess(policy, request);
  }
}

export class EnforcementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly source: "policy" | "application",
    readonly policyDecision: "allow" | "deny" | "approval_required" = "deny"
  ) {
    super(message);
    this.name = "EnforcementError";
  }
}

export interface SmithTasksEnforcementInput {
  policyArtifact: SignedArtifact<InvokeSmithPolicy>;
  policyStatus: PolicyStatusOptions;
  request: AccessEvaluationRequest;
  input: unknown;
  service: SmithTasksService;
  decisionClient: PolicyDecisionClient;
  applicationPrincipal?: Principal;
}

export interface SmithTasksEnforcementResult {
  status: "executed";
  output: Record<string, unknown>;
  evidence: {
    policyDigest: string;
    releaseDigest: string;
    policyDecision: "allow";
    applicationDecision: "allow";
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function policyContext(request: AccessEvaluationRequest): { digest: string; releaseDigest: string } {
  const extension = record(request.context?.invokesmith);
  const policy = record(extension?.policy);
  if (!policy || typeof policy.digest !== "string" || typeof policy.releaseDigest !== "string") {
    throw new EnforcementError("CS-ENFORCE-POLICY-CONTEXT-MISSING", "A complete deployed-policy identity is required before enforcement.", "policy");
  }
  return { digest: policy.digest, releaseDigest: policy.releaseDigest };
}

function normalizeDecision(value: unknown): AccessEvaluationResponse {
  const response = record(value);
  const context = record(response?.context);
  const invokesmith = record(context?.invokesmith);
  if (typeof response?.decision !== "boolean" ||
      !invokesmith ||
      !["allow", "deny", "approval_required"].includes(String(invokesmith.decision)) ||
      typeof invokesmith.reason !== "string" ||
      typeof invokesmith.policyDigest !== "string" ||
      typeof invokesmith.releaseDigest !== "string") {
    throw new EnforcementError("CS-ENFORCE-PDP-RESPONSE-MALFORMED", "The decision service returned an invalid InvokeSmith decision envelope; the request failed closed.", "policy");
  }
  return value as AccessEvaluationResponse;
}

export async function enforceSmithTasks(input: SmithTasksEnforcementInput): Promise<SmithTasksEnforcementResult> {
  const status = assessPolicyStatus(input.policyArtifact, input.policyStatus);
  if (!status.valid) {
    throw new EnforcementError("CS-ENFORCE-POLICY-STATUS", `${status.status}: ${status.reason} ${status.remediation}`, "policy");
  }
  const policy = input.policyArtifact.payload;
  const request = parseAccessEvaluationRequest(input.request);
  const deployed = policyContext(request);
  if (deployed.digest !== policy.policyDigest || deployed.releaseDigest !== policy.sources.release.digest) {
    throw new EnforcementError("CS-ENFORCE-POLICY-CONTEXT-MISMATCH", "The deployed policy or release identity does not match the policy being evaluated.", "policy");
  }
  const applicationInput = record(input.input);
  if (!applicationInput) throw new EnforcementError("CS-ENFORCE-INPUT-MALFORMED", "The application input must be an object.", "policy");
  const idField = policy.authorization.resource.idField;
  if (policy.action.effect !== "read_only" && (!idField || applicationInput[idField] !== request.resource.id)) {
    throw new EnforcementError("CS-ENFORCE-RESOURCE-MISMATCH", "The evaluated resource does not match the resource in the application input.", "policy");
  }
  const extension = record(request.context?.invokesmith);
  const subjectTenant = typeof request.subject.properties?.tenantId === "string" ? request.subject.properties.tenantId : "";
  if (input.applicationPrincipal && (input.applicationPrincipal.id !== request.subject.id ||
      input.applicationPrincipal.actor !== request.subject.type || input.applicationPrincipal.tenantId !== subjectTenant)) {
    throw new EnforcementError("CS-ENFORCE-PRINCIPAL-MISMATCH", "The authoritative application principal does not match the evaluated subject and tenant.", "policy");
  }
  const idempotencyObligation = policy.obligations.find((entry) => entry.id === "idempotency.key" && entry.required);
  if (idempotencyObligation) {
    const keyField = typeof idempotencyObligation.value === "string" ? idempotencyObligation.value : undefined;
    if (!keyField || applicationInput[keyField] !== extension?.idempotencyKey) {
      throw new EnforcementError("CS-ENFORCE-IDEMPOTENCY-MISMATCH", "The evaluated idempotency key does not match the application input.", "policy");
    }
  }

  let decision: AccessEvaluationResponse;
  try {
    decision = normalizeDecision(await input.decisionClient.evaluate(policy, request));
  } catch (error) {
    if (error instanceof EnforcementError) throw error;
    if (policy.action.effect === "read_only" && policy.runtime.unavailable === "allow_read_only") {
      const localFallback = evaluateAccess(policy, request);
      decision = localFallback.decision
        ? {
            decision: true,
            context: { invokesmith: { ...localFallback.context.invokesmith, reason: "CS-AUTHZEN-RISK-POSTURE-ALLOW-READ" } }
          }
        : localFallback;
    } else {
      throw new EnforcementError("CS-ENFORCE-PDP-UNAVAILABLE", "The local decision service is unavailable; the request failed closed.", "policy");
    }
  }
  if (!decision.decision || decision.context.invokesmith.decision !== "allow") {
    throw new EnforcementError(
      "CS-ENFORCE-POLICY-DENIED",
      `Policy did not permit execution (${decision.context.invokesmith.reason}).`,
      "policy",
      decision.context.invokesmith.decision
    );
  }
  if (decision.context.invokesmith.policyDigest !== policy.policyDigest ||
      decision.context.invokesmith.releaseDigest !== policy.sources.release.digest) {
    throw new EnforcementError("CS-ENFORCE-DECISION-MISMATCH", "The returned decision names a different policy or release.", "policy");
  }

  const scopes = Array.isArray(request.subject.properties?.scopes)
    ? request.subject.properties.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const principal = input.applicationPrincipal ?? {
    id: request.subject.id,
    actor: request.subject.type as Principal["actor"],
    scopes,
    tenantId: subjectTenant
  };
  const confirmation = record(extension?.confirmation);
  const context = {
    principal,
    contractDigest: policy.sources.contract.digest,
    confirmationAccepted: confirmation?.accepted === true
  };

  let output: Record<string, unknown>;
  try {
    if (policy.action.id === "dev.smithtasks.tasks.search") {
      output = await input.service.search(input.input as SearchTasksInput, context);
    } else if (policy.action.id === "dev.smithtasks.tasks.reschedule") {
      output = await input.service.reschedule(input.input as RescheduleTaskInput, context);
    } else if (policy.action.id === "dev.smithtasks.tasks.delete") {
      output = await input.service.delete(input.input as DeleteTaskInput, context);
    } else {
      throw new EnforcementError("CS-ENFORCE-ACTION-UNSUPPORTED", `No SmithTasks application adapter exists for ${policy.action.id}.`, "application", "allow");
    }
  } catch (error) {
    if (error instanceof EnforcementError) throw error;
    if (error instanceof SmithTasksError) throw new EnforcementError(error.code, error.message, "application", "allow");
    throw new EnforcementError("CS-ENFORCE-APPLICATION-FAILED", "The application rejected or failed the permitted operation.", "application", "allow");
  }
  return {
    status: "executed",
    output,
    evidence: {
      policyDigest: policy.policyDigest,
      releaseDigest: policy.sources.release.digest,
      policyDecision: "allow",
      applicationDecision: "allow"
    }
  };
}
