import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ActionContract } from "../packages/contract/src/index.js";
import { contractDigest, lowerActionContract, validateActionContract } from "../packages/compiler/src/index.js";
import { createEvidenceManifest, type EvidenceManifest } from "../packages/evidence/src/index.js";
import { compilePolicy, type InvokeSmithPolicy } from "../packages/policy/src/index.js";
import {
  signArtifact,
  verifyPolicyEvidenceBinding,
  verifySignedArtifact,
  type SignedArtifact
} from "../packages/signing/src/index.js";
import { assessPolicyStatus } from "../packages/policy-status/src/index.js";
import {
  makeReleaseDecision,
  verifyReleaseDecision,
  verifySignedReleaseDecision,
  type ReleaseGate
} from "../packages/release/src/index.js";
import type { ScenarioRunResult } from "../packages/testplan/src/index.js";

async function fixtures(options: { expiresAt?: string; failed?: boolean } = {}): Promise<{ policy: InvokeSmithPolicy; evidence: EvidenceManifest }> {
  const raw = JSON.parse(await readFile(new URL("../examples/smithtasks/reschedule-task.json", import.meta.url), "utf8")) as ActionContract;
  const validation = validateActionContract(raw);
  if (!validation.valid || !validation.value) throw new Error("invalid fixture");
  const action = lowerActionContract(validation.value);
  const result: ScenarioRunResult = {
    apiVersion: "invokesmith.outcome-result/v0alpha1", status: "passed",
    action: { id: action.id, version: action.version, contractDigest: action.source.digest },
    scenario: { id: action.scenarios[0]!.id, description: action.scenarios[0]!.description },
    planDigest: "sha256:" + "1".repeat(64), fixture: { id: "smithtasks-v1", digest: "sha256:" + "2".repeat(64) },
    environment: { runtime: "bun", runtimeVersion: "1.3.4", platform: "darwin" },
    target: { name: "mcp", serverName: "invokesmith-generated", protocolVersion: "2025-11-25", implementationVersion: "0.1.0" },
    observationProvider: { id: "invokesmith.smithtasks-json-file", version: "0.1.0", redaction: "minimized" },
    assertions: [
      { id: "contract.valid", classification: "structural", status: "passed", message: "valid", source: "harness" },
      { id: "security.authorized", classification: "security", status: "passed", message: "authorized", source: "mcp-target" },
      { id: "response.valid", classification: "response", status: "passed", message: "response", source: "mcp-response" },
      { id: "state.outcome", classification: "authoritative_state", status: "passed", message: "outcome", source: "observation-provider" }
    ]
  };
  const releaseId = "smithtasks-2026.09.1";
  const scenarioIds = [action.scenarios[0]!.id, `${action.scenarios[0]!.id}:retry`, `${action.scenarios[0]!.id}:conflict`];
  const passingResults: ScenarioRunResult[] = scenarioIds.map((id, index) => ({
    ...structuredClone(result),
    scenario: { ...result.scenario, id },
    planDigest: `sha256:${String(index + 1).padStart(64, "0")}`
  }));
  const evidenceResults = structuredClone(passingResults);
  if (options.failed) {
    evidenceResults[0]!.status = "failed";
    evidenceResults[0]!.assertions.find((entry) => entry.id === "state.outcome")!.status = "failed";
    evidenceResults[0]!.failureClass = "assertion";
    evidenceResults[0]!.failure = { code: "CS-ASSERT-001", step: "assert", source: "observer", message: "failed", remediation: "fix" };
  }
  const evidence = createEvidenceManifest(evidenceResults, { releaseId, environment: "test" });
  const passingEvidence = createEvidenceManifest(passingResults, { releaseId, environment: "test" });
  const implementation = passingEvidence.implementations[0]!;
  const policy = options.failed
    ? compilePolicy(action, passingEvidence, {
        release: { id: releaseId, digest: passingEvidence.release.digest }, implementation: { id: `${implementation.id}@${implementation.version}`, digest: contractDigest(implementation) }, environments: ["test"], ...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
      })
    : compilePolicy(action, evidence, {
        release: { id: releaseId, digest: evidence.release.digest }, implementation: { id: `${implementation.id}@${implementation.version}`, digest: contractDigest(implementation) }, environments: ["test"], ...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
      });
  return { policy, evidence };
}

describe("signed policy lifecycle and release decision", () => {
  test("signs policy and evidence with versioned Ed25519 identities and verifies offline", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { policy, evidence } = await fixtures();
    const signedPolicy = signArtifact(policy, { artifactType: "policy", keyId: "release-key-2026-09", privateKey });
    const signedEvidence = signArtifact(evidence, { artifactType: "evidence", keyId: "release-key-2026-09", privateKey });

    expect(signArtifact(policy, { artifactType: "policy", keyId: "release-key-2026-09", privateKey })).toEqual(signedPolicy);
    expect(signedPolicy).toMatchObject({ apiVersion: "invokesmith.signature/v0alpha1", algorithm: "Ed25519", keyId: "release-key-2026-09", artifactType: "policy" });
    expect(verifySignedArtifact(signedPolicy, { publicKey })).toEqual({ valid: true });
    expect(verifyPolicyEvidenceBinding(signedPolicy, signedEvidence, { policyPublicKey: publicKey, evidencePublicKey: publicKey })).toEqual({ valid: true });
    expect(JSON.stringify(signedPolicy)).not.toContain("PRIVATE KEY");

    const changed = structuredClone(signedPolicy); changed.payload.action.id = "changed.action";
    expect(verifySignedArtifact(changed, { publicKey })).toMatchObject({ valid: false, code: "CS-SIGN-CONTENT-CHANGED" });
    const wrongKey = generateKeyPairSync("ed25519").publicKey;
    expect(verifySignedArtifact(signedPolicy, { publicKey: wrongKey })).toMatchObject({ valid: false, code: "CS-SIGN-INVALID" });
    const unsupported = { ...signedPolicy, apiVersion: "invokesmith.signature/v9" } as unknown as SignedArtifact<InvokeSmithPolicy>;
    expect(verifySignedArtifact(unsupported, { publicKey })).toMatchObject({ valid: false, code: "CS-SIGN-VERSION-UNSUPPORTED" });

    const wrongReleasePolicy = structuredClone(policy);
    wrongReleasePolicy.sources.release.digest = "sha256:" + "9".repeat(64);
    const { policyDigest: _releaseDigest, ...wrongReleaseUnsigned } = wrongReleasePolicy;
    wrongReleasePolicy.policyDigest = contractDigest(wrongReleaseUnsigned);
    const signedWrongReleasePolicy = signArtifact(wrongReleasePolicy, { artifactType: "policy", keyId: "release-key-2026-09", privateKey });
    expect(verifyPolicyEvidenceBinding(signedWrongReleasePolicy, signedEvidence, { policyPublicKey: publicKey, evidencePublicKey: publicKey }))
      .toMatchObject({ valid: false, code: "CS-SIGN-BINDING-RELEASE" });

    const alternateRun = structuredClone(evidence.runs[0]!);
    alternateRun.action = { ...alternateRun.action, id: "dev.smithtasks.tasks.other" };
    alternateRun.target = { ...alternateRun.target, serverName: "other-implementation", implementationVersion: "2.0.0" };
    const alternateImplementation = { target: alternateRun.target.name, id: alternateRun.target.serverName, version: alternateRun.target.implementationVersion };
    const mixedEvidence = structuredClone(evidence);
    mixedEvidence.runs.push(alternateRun);
    mixedEvidence.runs.sort((left, right) => left.action.id.localeCompare(right.action.id) || left.scenario.id.localeCompare(right.scenario.id));
    mixedEvidence.contracts.push({ id: alternateRun.action.id, version: alternateRun.action.version, digest: alternateRun.action.contractDigest });
    mixedEvidence.contracts.sort((left, right) => left.id.localeCompare(right.id));
    mixedEvidence.implementations.push(alternateImplementation);
    mixedEvidence.implementations.sort((left, right) => left.target.localeCompare(right.target) || left.id.localeCompare(right.id));
    mixedEvidence.suite.resultCount = mixedEvidence.runs.length;
    const { manifestDigest: _mixedDigest, ...mixedUnsigned } = mixedEvidence;
    mixedEvidence.manifestDigest = contractDigest(mixedUnsigned);
    const incorrectlyBoundPolicy = structuredClone(policy);
    incorrectlyBoundPolicy.sources.evidence.digest = mixedEvidence.manifestDigest;
    incorrectlyBoundPolicy.sources.implementation = { id: `${alternateImplementation.id}@${alternateImplementation.version}`, digest: contractDigest(alternateImplementation) };
    const { policyDigest: _implementationDigest, ...incorrectlyBoundUnsigned } = incorrectlyBoundPolicy;
    incorrectlyBoundPolicy.policyDigest = contractDigest(incorrectlyBoundUnsigned);
    const signedIncorrectlyBoundPolicy = signArtifact(incorrectlyBoundPolicy, { artifactType: "policy", keyId: "release-key-2026-09", privateKey });
    const signedMixedEvidence = signArtifact(mixedEvidence, { artifactType: "evidence", keyId: "release-key-2026-09", privateKey });
    expect(verifyPolicyEvidenceBinding(signedIncorrectlyBoundPolicy, signedMixedEvidence, { policyPublicKey: publicKey, evidencePublicKey: publicKey }))
      .toMatchObject({ valid: false, code: "CS-SIGN-BINDING-IMPLEMENTATION" });
  });

  test("fails closed with exact stale, expired, revoked, replaced, and corrupted policy status", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { policy } = await fixtures({ expiresAt: "2026-09-10T00:00:00Z" });
    const signed = signArtifact(policy, { artifactType: "policy", keyId: "release-key", privateKey });
    const base = { publicKey, now: "2026-09-09T12:00:00Z", expectedContractDigest: policy.sources.contract.digest, expectedReleaseDigest: policy.sources.release.digest };

    expect(assessPolicyStatus(signed, base)).toMatchObject({ valid: true, status: "valid" });
    expect(assessPolicyStatus(signed, { ...base, expectedContractDigest: "sha256:new-contract" })).toMatchObject({ valid: false, status: "stale_contract", remediation: expect.any(String) });
    expect(assessPolicyStatus(signed, { ...base, expectedReleaseDigest: "sha256:new-release" })).toMatchObject({ valid: false, status: "stale_release" });
    expect(assessPolicyStatus(signed, { ...base, now: "2026-09-11T00:00:00Z" })).toMatchObject({ valid: false, status: "expired" });
    expect(assessPolicyStatus(signed, { ...base, revokedPolicyDigests: [policy.policyDigest] })).toMatchObject({ valid: false, status: "revoked" });
    expect(assessPolicyStatus(signed, { ...base, replacements: { [policy.policyDigest]: "sha256:new-policy" } })).toMatchObject({ valid: false, status: "replaced" });
    const corrupted = structuredClone(signed); corrupted.signature = "invalid";
    expect(assessPolicyStatus(corrupted, base)).toMatchObject({ valid: false, status: "invalid_signature" });
    expect(assessPolicyStatus(signed, { ...base, now: "not-a-date" })).toMatchObject({ valid: false, status: "malformed" });
    const invalidExpiryPolicy = structuredClone(policy); invalidExpiryPolicy.lifecycle.expiresAt = "not-a-date";
    const { policyDigest: _digest, ...unsigned } = invalidExpiryPolicy;
    invalidExpiryPolicy.policyDigest = contractDigest(unsigned);
    const invalidExpiry = signArtifact(invalidExpiryPolicy, { artifactType: "policy", keyId: "release-key", privateKey });
    expect(assessPolicyStatus(invalidExpiry, base)).toMatchObject({ valid: false, status: "malformed" });
    const wrongType = signArtifact(policy, { artifactType: "evidence", keyId: "release-key", privateKey }) as unknown as SignedArtifact<InvokeSmithPolicy>;
    expect(assessPolicyStatus(wrongType, base)).toMatchObject({ valid: false, status: "malformed" });
  });

  test("makes deterministic release approvals and blocks failed, missing, stale, or mismatched evidence", async () => {
    const { policy, evidence } = await fixtures();
    const gate: ReleaseGate = { require: ["structural", "security", "outcome"] };
    const status = { valid: true, status: "valid" } as const;
    const options = { gate, policyStatus: status, approvedBy: "security@example.test", decidedAt: "2026-09-09T12:00:00Z" };
    const first = makeReleaseDecision(policy, evidence, options);
    const second = makeReleaseDecision(structuredClone(policy), structuredClone(evidence), options);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ status: "approved", sources: { contract: { digest: policy.sources.contract.digest }, implementation: policy.sources.implementation, policy: { digest: policy.policyDigest }, evidence: { digest: evidence.manifestDigest } }, approval: { approvedBy: "security@example.test" } });
    expect(verifyReleaseDecision(first, policy, evidence, status, gate)).toEqual({ valid: true });

    const failed = await fixtures({ failed: true });
    expect(makeReleaseDecision(failed.policy, failed.evidence, options)).toMatchObject({ status: "blocked", reasons: expect.arrayContaining([expect.objectContaining({ code: "CS-RELEASE-EVIDENCE-FAILED" })]) });
    const missing = structuredClone(evidence); missing.runs[0]!.assertions = missing.runs[0]!.assertions.filter((entry) => entry.classification !== "security");
    expect(makeReleaseDecision(policy, missing, options)).toMatchObject({ status: "blocked", reasons: expect.arrayContaining([expect.objectContaining({ code: "CS-RELEASE-EVIDENCE-INVALID" })]) });
    expect(makeReleaseDecision(policy, evidence, { ...options, policyStatus: { valid: false, status: "stale_contract", reason: "stale", remediation: "recompile" } })).toMatchObject({ status: "blocked", reasons: expect.arrayContaining([expect.objectContaining({ code: "CS-RELEASE-POLICY-INVALID" })]) });
  });

  test("authenticates and reproduces every signed release-decision identity", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { policy, evidence } = await fixtures();
    const gate: ReleaseGate = { require: ["structural", "security", "outcome"] };
    const status = { valid: true, status: "valid" } as const;
    const decision = makeReleaseDecision(policy, evidence, { gate, policyStatus: status, approvedBy: "security@example.test", decidedAt: "2026-09-09T12:00:00Z" });
    const signed = signArtifact(decision, { artifactType: "release_decision", keyId: "release-key", privateKey });
    expect(verifySignedReleaseDecision(signed, { publicKey, policy, evidence, policyStatus: status, expectedGate: gate })).toEqual({ valid: true });

    const changed = structuredClone(decision);
    changed.sources.implementation.id = "untested@9";
    const { decisionDigest: _digest, ...unsigned } = changed;
    changed.decisionDigest = contractDigest(unsigned);
    const signedChanged = signArtifact(changed, { artifactType: "release_decision", keyId: "release-key", privateKey });
    expect(verifySignedReleaseDecision(signedChanged, { publicKey, policy, evidence, policyStatus: status, expectedGate: gate }))
      .toMatchObject({ valid: false, code: "CS-RELEASE-SOURCE-MISMATCH" });
    expect(verifySignedReleaseDecision(signed, { publicKey: generateKeyPairSync("ed25519").publicKey, policy, evidence, policyStatus: status, expectedGate: gate }))
      .toMatchObject({ valid: false, code: "CS-SIGN-INVALID" });
  });
});
