import { contractDigest, type IntermediateAction } from "../../compiler/src/index.js";
import { verifyEvidenceManifest, type EvidenceManifest } from "../../evidence/src/index.js";

export const POLICY_IR_VERSION = "invokesmith.policy/v0alpha1" as const;

export type ObligationDisposition =
  | "native"
  | "generated"
  | "application"
  | "gateway"
  | "verified_only"
  | "unsupported";

export interface PolicyException {
  findingId: string;
  approvedBy: string;
  justification: string;
}

export interface PolicyObligation {
  id: string;
  disposition: ObligationDisposition;
  required: boolean;
  value?: string | boolean | string[];
}

export interface PolicyLossFinding {
  id: string;
  code: string;
  disposition: "unsupported";
  message: string;
  remediation: string;
  exception?: Omit<PolicyException, "findingId">;
}

export interface InvokeSmithPolicy {
  apiVersion: typeof POLICY_IR_VERSION;
  policyDigest: string;
  sources: {
    contract: { id: string; version: string; digest: string };
    implementation: { id: string; digest: string };
    evidence: { digest: string; releaseId: string; environment: string; scenarioIds: string[] };
    release: { id: string; digest: string };
  };
  action: { id: string; effect: IntermediateAction["effects"]["classifications"][number] };
  authorization: {
    required: boolean;
    actor: IntermediateAction["authorization"]["actor"];
    caller: { required: boolean; bindToSubject: boolean };
    scopes: string[];
    resource: { ownerBound: true; tenantBound: true; idField?: string };
    environments: string[];
  };
  confirmation: {
    required: boolean;
    bind: Array<"subject" | "action" | "resource" | "facts">;
    facts: string[];
  };
  runtime: { unavailable: "fail_closed" | "allow_read_only" };
  lifecycle: { expiresAt?: string; replaces?: string };
  obligations: PolicyObligation[];
  loss: { findings: PolicyLossFinding[] };
}

export interface CompilePolicyOptions {
  release: { id: string; digest: string };
  implementation: { id: string; digest: string };
  environments?: string[];
  unavailable?: "fail_closed" | "allow_read_only";
  expiresAt?: string;
  replaces?: string;
  exceptions?: PolicyException[];
}

export class PolicyCompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation: string
  ) {
    super(message);
    this.name = "PolicyCompileError";
  }
}

function primaryEffect(action: IntermediateAction): IntermediateAction["effects"]["classifications"][number] {
  const precedence = ["destructive", "financial", "external_communication", "open_world", "reversible", "read_only"] as const;
  return precedence.find((effect) => action.effects.classifications.includes(effect)) ?? "read_only";
}

function resourceIdField(action: IntermediateAction): string | undefined {
  const properties = action.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  for (const candidate of ["taskId", "resourceId", "projectId", "id"]) {
    if (candidate in properties) return candidate;
  }
  return undefined;
}

function targetLosses(action: IntermediateAction, exceptions: PolicyException[]): PolicyLossFinding[] {
  const override = action.targetOverrides.policy;
  if (!override) return [];
  const supported = new Set(["confirmationRequired", "idempotencyRequired", "auditReceiptRequired"]);
  const unknown = Object.keys(override).filter((key) => !supported.has(key)).sort((left, right) => left.localeCompare(right));
  const unknownFindings = unknown.map((key): PolicyLossFinding => {
    const id = `target.policy.${key}`;
    const accepted = exceptions.find((entry) => entry.findingId === id);
    return {
      id,
      code: "CS-POLICY-LOSS-002",
      disposition: "unsupported",
      message: `The policy target override ${key} is not supported by this compiler.`,
      remediation: `Remove the override or provide an attributable, reviewed exception for ${id}.`,
      ...(accepted ? { exception: { approvedBy: accepted.approvedBy, justification: accepted.justification } } : {})
    };
  });
  const dangerous: Array<[string, unknown, unknown]> = [
    ["confirmationRequired", override.confirmationRequired, action.confirmation.required],
    ["idempotencyRequired", override.idempotencyRequired, action.idempotency.mode === "key_required"],
    ["auditReceiptRequired", override.auditReceiptRequired, action.audit.receiptRequired]
  ];
  return [...unknownFindings, ...dangerous.flatMap(([key, requested, required]) => {
    if (required !== true || requested !== false) return [];
    const id = `target.policy.${key}`;
    const accepted = exceptions.find((entry) => entry.findingId === id);
    return [{
      id,
      code: "CS-POLICY-LOSS-001",
      disposition: "unsupported" as const,
      message: `The policy target override weakens required ${key}.`,
      remediation: `Remove the override or provide an attributable, reviewed exception for ${id}.`,
      ...(accepted ? { exception: { approvedBy: accepted.approvedBy, justification: accepted.justification } } : {})
    }];
  })];
}

function obligations(action: IntermediateAction): PolicyObligation[] {
  const values: PolicyObligation[] = [
    { id: "authorization.actor", disposition: "native", required: action.authorization.required, value: action.authorization.actor },
    { id: "authorization.caller", disposition: "generated", required: action.effects.mutating, value: "bind_to_subject" },
    { id: "authorization.scopes", disposition: "native", required: action.authorization.required, value: action.authorization.scopes },
    { id: "resource.identity", disposition: "generated", required: true, ...(resourceIdField(action) ? { value: resourceIdField(action)! } : {}) },
    { id: "resource.application_authority", disposition: "application", required: true },
    { id: "outcome.contract", disposition: "verified_only", required: true }
  ];
  if (action.idempotency.mode === "key_required") {
    values.push({ id: "idempotency.key", disposition: "application", required: true, ...(action.idempotency.keyField ? { value: action.idempotency.keyField } : {}) });
    values.push({ id: "idempotency.retry_safe", disposition: "application", required: action.idempotency.retrySafe });
  }
  if (action.audit.receiptRequired) values.push({ id: "audit.receipt", disposition: "verified_only", required: true });
  if (action.effects.compensationAction) values.push({ id: "recovery.compensation", disposition: "verified_only", required: true, value: action.effects.compensationAction });
  if (action.effects.recoveryWindow) values.push({ id: "recovery.window", disposition: "verified_only", required: true, value: action.effects.recoveryWindow });
  if (action.confirmation.required) values.push({ id: "confirmation.proof", disposition: "gateway", required: true, value: action.confirmation.facts ?? [] });
  return values.sort((left, right) => left.id.localeCompare(right.id));
}

export function compilePolicy(
  action: IntermediateAction,
  evidence: EvidenceManifest,
  options: CompilePolicyOptions
): InvokeSmithPolicy {
  const evidenceValidity = verifyEvidenceManifest(evidence);
  if (!evidenceValidity.valid) {
    throw new PolicyCompileError("CS-POLICY-EVIDENCE-001", "Outcome evidence has an invalid manifest digest.", "Regenerate and re-verify the evidence before compiling policy.");
  }
  const matchingRuns = evidence.runs.filter((run) => run.action.id === action.id && run.action.contractDigest === action.source.digest);
  if (matchingRuns.length === 0 || matchingRuns.some((run) => run.status !== "passed" || run.assertions.some((assertion) => assertion.status !== "passed"))) {
    throw new PolicyCompileError("CS-POLICY-EVIDENCE-002", "Outcome evidence does not contain passing results for this exact contract.", "Run InvokeSmith outcome tests for this contract and implementation.");
  }
  if (evidence.release.id !== options.release.id || evidence.release.digest !== options.release.digest) {
    throw new PolicyCompileError("CS-POLICY-EVIDENCE-003", "Outcome evidence and policy name different releases.", "Regenerate evidence for the release being compiled.");
  }
  const implementation = evidence.implementations.find((entry) =>
    options.implementation.id === entry.id || options.implementation.id === `${entry.id}@${entry.version}`);
  if (!implementation || options.implementation.digest !== contractDigest(implementation)) {
    throw new PolicyCompileError("CS-POLICY-EVIDENCE-005", "The claimed implementation identity is not present in outcome evidence.", "Select the exact tested implementation and use its evidence-derived digest.");
  }
  const implementationRuns = matchingRuns.filter((run) => run.target.name === implementation.target && run.target.serverName === implementation.id && run.target.implementationVersion === implementation.version);
  const environments = options.environments ?? [evidence.release.environment];
  if (environments.length !== 1 || environments[0] !== evidence.release.environment) {
    throw new PolicyCompileError("CS-POLICY-EVIDENCE-006", "The claimed deployment environment is not the environment named by the evidence.", "Generate evidence in the intended environment before compiling policy.");
  }
  const expectedScenarioIds = action.scenarios.flatMap((scenario) => [
    scenario.id,
    ...(action.idempotency.mode === "key_required" ? [`${scenario.id}:retry`, `${scenario.id}:conflict`] : []),
    ...(action.confirmation.required ? [`${scenario.id}:confirmation-rejected`, `${scenario.id}:confirmation-missing`] : [])
  ]).sort((left, right) => left.localeCompare(right));
  const observedScenarioIds = new Set(implementationRuns.map((run) => run.scenario.id));
  const missingScenario = expectedScenarioIds.find((scenarioId) => !observedScenarioIds.has(scenarioId));
  if (missingScenario) {
    throw new PolicyCompileError("CS-POLICY-EVIDENCE-004", `Outcome evidence is missing required scenario ${missingScenario}.`, "Run the complete contract and generated safety suite before compiling policy.");
  }

  const findings = targetLosses(action, options.exceptions ?? []);
  const unaccepted = findings.find((finding) => !finding.exception);
  if (unaccepted) throw new PolicyCompileError(unaccepted.code, unaccepted.message, unaccepted.remediation);

  const idField = resourceIdField(action);
  const lifecycle: InvokeSmithPolicy["lifecycle"] = {
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.replaces ? { replaces: options.replaces } : {})
  };
  const unsigned = {
    apiVersion: POLICY_IR_VERSION,
    sources: {
      contract: { id: action.id, version: action.version, digest: action.source.digest },
      implementation: structuredClone(options.implementation),
      evidence: { digest: evidence.manifestDigest, releaseId: evidence.release.id, environment: evidence.release.environment, scenarioIds: expectedScenarioIds },
      release: structuredClone(options.release)
    },
    action: { id: action.id, effect: primaryEffect(action) },
    authorization: {
      required: action.authorization.required,
      actor: action.authorization.actor,
      caller: { required: action.effects.mutating, bindToSubject: true },
      scopes: [...action.authorization.scopes].sort((left, right) => left.localeCompare(right)),
      resource: { ownerBound: true as const, tenantBound: true as const, ...(idField ? { idField } : {}) },
      environments: [...environments]
    },
    confirmation: {
      required: action.confirmation.required,
      bind: action.confirmation.required
        ? (["subject", "action", "resource", "facts"] as InvokeSmithPolicy["confirmation"]["bind"])
        : [],
      facts: [...(action.confirmation.facts ?? [])].sort((left, right) => left.localeCompare(right))
    },
    runtime: { unavailable: options.unavailable ?? "fail_closed" },
    lifecycle,
    obligations: obligations(action),
    loss: { findings }
  };
  return { ...unsigned, policyDigest: contractDigest(unsigned) };
}

export function verifyPolicyIdentity(policy: InvokeSmithPolicy): { valid: true } | { valid: false; expectedDigest: string } {
  const { policyDigest, ...unsigned } = policy;
  const expectedDigest = contractDigest(unsigned);
  return expectedDigest === policyDigest ? { valid: true } : { valid: false, expectedDigest };
}
