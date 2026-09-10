import type { KeyLike } from "node:crypto";
import { canonicalize, contractDigest } from "../../compiler/src/index.js";
import { verifyEvidenceManifest, type EvidenceManifest } from "../../evidence/src/index.js";
import { verifyPolicyIdentity, type InvokeSmithPolicy } from "../../policy/src/index.js";
import type { PolicyStatus } from "../../policy-status/src/index.js";
import { verifySignedArtifact, type SignedArtifact } from "../../signing/src/index.js";

export const RELEASE_DECISION_VERSION = "invokesmith.release-decision/v0alpha1" as const;
export type ReleaseEvidenceClass = "structural" | "security" | "outcome";

export interface ReleaseGate {
  require: ReleaseEvidenceClass[];
}

export interface ReleaseReason {
  code: string;
  message: string;
  remediation: string;
}

export interface ReleaseDecision {
  apiVersion: typeof RELEASE_DECISION_VERSION;
  decisionDigest: string;
  status: "approved" | "blocked";
  gate: ReleaseGate;
  sources: {
    contract: { id: string; digest: string };
    implementation: { id: string; digest: string };
    policy: { digest: string };
    evidence: { digest: string };
    release: { id: string; digest: string };
    environments: EvidenceManifest["environments"];
  };
  approval?: { approvedBy: string; decidedAt: string };
  reasons: ReleaseReason[];
}

function requiredClassPresent(evidence: EvidenceManifest, requirement: ReleaseEvidenceClass): boolean {
  const classifications = requirement === "outcome" ? ["response", "authoritative_state"] : [requirement];
  return evidence.runs.some((run) => run.assertions.some((assertion) => classifications.includes(assertion.classification) && assertion.status === "passed"));
}

export function makeReleaseDecision(
  policy: InvokeSmithPolicy,
  evidence: EvidenceManifest,
  options: { gate: ReleaseGate; policyStatus: PolicyStatus; approvedBy: string; decidedAt: string }
): ReleaseDecision {
  const reasons: ReleaseReason[] = [];
  if (!verifyPolicyIdentity(policy).valid) reasons.push({ code: "CS-RELEASE-POLICY-DIGEST", message: "Policy identity verification failed.", remediation: "Regenerate the policy from trusted inputs." });
  if (!options.policyStatus.valid) reasons.push({ code: "CS-RELEASE-POLICY-INVALID", message: `Policy status is ${options.policyStatus.status}: ${options.policyStatus.reason}`, remediation: options.policyStatus.remediation });
  if (!verifyEvidenceManifest(evidence).valid) reasons.push({ code: "CS-RELEASE-EVIDENCE-INVALID", message: "Evidence manifest verification failed.", remediation: "Regenerate and verify the evidence manifest." });
  if (evidence.runs.some((run) => run.status === "failed" || run.assertions.some((assertion) => assertion.status === "failed"))) {
    reasons.push({ code: "CS-RELEASE-EVIDENCE-FAILED", message: "At least one required outcome run or assertion failed.", remediation: "Correct the implementation or policy and rerun the suite." });
  }
  if (policy.sources.evidence.digest !== evidence.manifestDigest || policy.sources.release.id !== evidence.release.id ||
      !evidence.contracts.some((entry) => entry.id === policy.sources.contract.id && entry.digest === policy.sources.contract.digest)) {
    reasons.push({ code: "CS-RELEASE-EVIDENCE-MISMATCH", message: "Evidence is not bound to the policy contract and release.", remediation: "Use evidence generated for this exact policy source and release." });
  }
  const observedScenarios = new Set(evidence.runs.filter((run) => run.status === "passed").map((run) => run.scenario.id));
  for (const scenarioId of policy.sources.evidence.scenarioIds) {
    if (!observedScenarios.has(scenarioId)) reasons.push({ code: "CS-RELEASE-SCENARIO-MISSING", message: `Required scenario ${scenarioId} is missing or failed.`, remediation: "Run the complete approved outcome suite." });
  }
  for (const requirement of [...new Set(options.gate.require)].sort()) {
    if (!requiredClassPresent(evidence, requirement)) {
      reasons.push({ code: "CS-RELEASE-EVIDENCE-MISSING", message: `Required ${requirement} evidence is missing.`, remediation: `Add passing ${requirement} assertions to the release suite.` });
    }
  }
  reasons.sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  const status = reasons.length === 0 ? "approved" as const : "blocked" as const;
  const unsigned = {
    apiVersion: RELEASE_DECISION_VERSION,
    status,
    gate: { require: [...new Set(options.gate.require)].sort() as ReleaseEvidenceClass[] },
    sources: {
      contract: { id: policy.sources.contract.id, digest: policy.sources.contract.digest },
      implementation: structuredClone(policy.sources.implementation),
      policy: { digest: policy.policyDigest },
      evidence: { digest: evidence.manifestDigest },
      release: structuredClone(policy.sources.release),
      environments: structuredClone(evidence.environments)
    },
    ...(status === "approved" ? { approval: { approvedBy: options.approvedBy, decidedAt: options.decidedAt } } : {}),
    reasons
  };
  return { ...unsigned, decisionDigest: contractDigest(unsigned) };
}

export function verifyReleaseDecision(
  decision: ReleaseDecision,
  policy: InvokeSmithPolicy,
  evidence: EvidenceManifest,
  policyStatus: PolicyStatus,
  expectedGate: ReleaseGate
): { valid: true } | { valid: false; code: string; message: string } {
  const { decisionDigest, ...unsigned } = decision;
  if (contractDigest(unsigned) !== decisionDigest) return { valid: false, code: "CS-RELEASE-DECISION-CHANGED", message: "Release decision content does not match its identity." };
  if (!verifyPolicyIdentity(policy).valid || !verifyEvidenceManifest(evidence).valid) return { valid: false, code: "CS-RELEASE-SOURCE-INVALID", message: "A referenced policy or evidence artifact is invalid." };
  if (decision.status === "approved" && !decision.approval) return { valid: false, code: "CS-RELEASE-APPROVAL-MISSING", message: "An approved decision has no approval identity." };
  const expected = makeReleaseDecision(policy, evidence, {
    gate: expectedGate,
    policyStatus,
    approvedBy: decision.approval?.approvedBy ?? "blocked",
    decidedAt: decision.approval?.decidedAt ?? "1970-01-01T00:00:00Z"
  });
  if (canonicalize(expected) !== canonicalize(decision)) return { valid: false, code: "CS-RELEASE-SOURCE-MISMATCH", message: "Release decision does not reproduce from the supplied policy, status, evidence, gate, and approval." };
  return { valid: true };
}

export function verifySignedReleaseDecision(
  artifact: SignedArtifact<ReleaseDecision>,
  options: { publicKey: KeyLike; policy: InvokeSmithPolicy; evidence: EvidenceManifest; policyStatus: PolicyStatus; expectedGate: ReleaseGate }
): { valid: true } | { valid: false; code: string; message: string } {
  if (artifact.artifactType !== "release_decision") return { valid: false, code: "CS-RELEASE-SIGNATURE-TYPE", message: "Expected a signed release decision artifact." };
  const signature = verifySignedArtifact(artifact, { publicKey: options.publicKey });
  if (!signature.valid) return { valid: false, code: signature.code ?? "CS-SIGN-INVALID", message: signature.message ?? "Release decision signature verification failed." };
  return verifyReleaseDecision(artifact.payload, options.policy, options.evidence, options.policyStatus, options.expectedGate);
}
