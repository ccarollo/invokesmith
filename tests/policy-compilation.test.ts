import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ActionContract } from "../packages/contract/src/index.js";
import { contractDigest, lowerActionContract, validateActionContract } from "../packages/compiler/src/index.js";
import { createEvidenceManifest } from "../packages/evidence/src/index.js";
import {
  compilePolicy,
  PolicyCompileError,
  verifyPolicyIdentity,
  type InvokeSmithPolicy
} from "../packages/policy/src/index.js";
import type { ScenarioRunResult } from "../packages/testplan/src/index.js";

async function loadAction(name: string) {
  const input = JSON.parse(await readFile(new URL(`../examples/smithtasks/${name}.json`, import.meta.url), "utf8")) as ActionContract;
  const result = validateActionContract(input);
  if (!result.valid || !result.value) throw new Error(`${name} reference action is invalid`);
  return lowerActionContract(result.value);
}

function evidenceFor(action: Awaited<ReturnType<typeof loadAction>>, releaseId = "smithtasks-2026.09.1") {
  const base: ScenarioRunResult = {
    apiVersion: "invokesmith.outcome-result/v0alpha1",
    status: "passed",
    action: { id: action.id, version: action.version, contractDigest: action.source.digest },
    scenario: { id: action.scenarios[0]!.id, description: action.scenarios[0]!.description },
    planDigest: "sha256:" + "1".repeat(64),
    fixture: { id: "smithtasks-v1", digest: "sha256:" + "2".repeat(64) },
    environment: { runtime: "bun", runtimeVersion: "1.3.4", platform: "darwin" },
    target: { name: "mcp", serverName: "invokesmith-generated", protocolVersion: "2025-11-25", implementationVersion: "0.1.0" },
    observationProvider: { id: "invokesmith.smithtasks-json-file", version: "0.1.0", redaction: "minimized" },
    assertions: [
      { id: "contract.valid", classification: "structural", status: "passed", message: "valid", source: "harness" },
      { id: "security.authorized", classification: "security", status: "passed", message: "authorized", source: "mcp-target" },
      { id: "state.outcome", classification: "authoritative_state", status: "passed", message: "proved", source: "observation-provider" }
    ]
  };
  const scenarioIds = action.scenarios.flatMap((scenario) => [
    scenario.id,
    ...(action.idempotency.mode === "key_required" ? [`${scenario.id}:retry`, `${scenario.id}:conflict`] : []),
    ...(action.confirmation.required ? [`${scenario.id}:confirmation-rejected`, `${scenario.id}:confirmation-missing`] : [])
  ]);
  return createEvidenceManifest(scenarioIds.map((id, index) => ({
    ...structuredClone(base), scenario: { ...base.scenario, id }, planDigest: `sha256:${String(index + 1).padStart(64, "0")}`
  })), { releaseId, environment: "test" });
}

function compile(action: Awaited<ReturnType<typeof loadAction>>, releaseId = "smithtasks-2026.09.1"): InvokeSmithPolicy {
  const evidence = evidenceFor(action, releaseId);
  const implementation = evidence.implementations[0]!;
  return compilePolicy(action, evidence, {
    release: { id: releaseId, digest: evidence.release.digest },
    implementation: { id: `${implementation.id}@${implementation.version}`, digest: contractDigest(implementation) },
    environments: ["test"]
  });
}

describe("Policy IR", () => {
  test("compiles read policy deterministically with all source identities and obligation dispositions", async () => {
    const action = await loadAction("search-tasks");
    const first = compile(action);
    const second = compile(structuredClone(action));

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      apiVersion: "invokesmith.policy/v0alpha1",
      sources: {
        contract: { id: action.id, digest: action.source.digest },
        implementation: { id: "invokesmith-generated@0.1.0" },
        evidence: { digest: evidenceFor(action).manifestDigest },
        release: { id: "smithtasks-2026.09.1" }
      },
      action: { id: action.id, effect: "read_only" },
      runtime: { unavailable: "fail_closed" }
    });
    expect(verifyPolicyIdentity(first)).toEqual({ valid: true });
    expect(new Set(first.obligations.map((entry) => entry.disposition))).toEqual(
      new Set(["native", "generated", "application", "verified_only"])
    );
    expect(first.policyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("preserves reversible-write identity, resource, idempotency, audit, and recovery obligations", async () => {
    const action = await loadAction("reschedule-task");
    const policy = compile(action);

    expect(policy.authorization).toMatchObject({ actor: "user", caller: { required: true, bindToSubject: true }, scopes: ["tasks:write"], resource: { idField: "taskId", ownerBound: true, tenantBound: true } });
    expect(policy.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "idempotency.key", disposition: "application", required: true }),
      expect.objectContaining({ id: "idempotency.retry_safe", disposition: "application", required: true }),
      expect.objectContaining({ id: "audit.receipt", disposition: "verified_only", required: true }),
      expect.objectContaining({ id: "recovery.compensation", disposition: "verified_only", value: "dev.smithtasks.tasks.restore_schedule" })
    ]));

    const changed = structuredClone(action);
    changed.audit.receiptRequired = false;
    expect(compile(changed).policyDigest).not.toBe(policy.policyDigest);
  });

  test("binds destructive confirmation and refuses silent weakening without an attributable exception", async () => {
    const action = await loadAction("delete-task");
    const policy = compile(action);
    expect(policy.confirmation).toMatchObject({
      required: true,
      bind: ["subject", "action", "resource", "facts"],
      facts: ["input.taskId", "recoveryWindow"]
    });
    expect(policy.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "confirmation.proof", disposition: "gateway", required: true }),
      expect.objectContaining({ id: "recovery.window", value: "P30D" }),
      expect.objectContaining({ id: "audit.receipt", required: true })
    ]));

    const weakened = structuredClone(action);
    weakened.targetOverrides.policy = { confirmationRequired: false };
    expect(() => compile(weakened)).toThrow(PolicyCompileError);
    try {
      compile(weakened);
    } catch (error) {
      expect(error).toMatchObject({ code: "CS-POLICY-LOSS-001" });
    }

    const weakenedEvidence = evidenceFor(weakened);
    const weakenedImplementation = weakenedEvidence.implementations[0]!;
    const accepted = compilePolicy(weakened, weakenedEvidence, {
      release: { id: "smithtasks-2026.09.1", digest: weakenedEvidence.release.digest },
      implementation: { id: `${weakenedImplementation.id}@${weakenedImplementation.version}`, digest: contractDigest(weakenedImplementation) },
      environments: ["test"],
      exceptions: [{ findingId: "target.policy.confirmationRequired", approvedBy: "security@example.test", justification: "isolated adversarial fixture" }]
    });
    expect(accepted.loss.findings[0]).toMatchObject({ disposition: "unsupported", exception: { approvedBy: "security@example.test" } });

    const unknown = structuredClone(action);
    unknown.targetOverrides.policy = { futureApprovalMode: "silent" };
    expect(() => compile(unknown)).toThrow(expect.objectContaining({ code: "CS-POLICY-LOSS-002" }));
  });

  test("rejects evidence or release that does not match the protected action", async () => {
    const search = await loadAction("search-tasks");
    const deletion = await loadAction("delete-task");
    const searchEvidence = evidenceFor(search);
    const implementation = searchEvidence.implementations[0]!;
    expect(() => compilePolicy(deletion, searchEvidence, {
      release: { id: "smithtasks-2026.09.1", digest: searchEvidence.release.digest },
      implementation: { id: `${implementation.id}@${implementation.version}`, digest: contractDigest(implementation) }, environments: ["test"]
    })).toThrow(expect.objectContaining({ code: "CS-POLICY-EVIDENCE-002" }));
    const otherEvidence = evidenceFor(search, "other-release");
    const otherImplementation = otherEvidence.implementations[0]!;
    expect(() => compilePolicy(search, otherEvidence, {
      release: { id: "smithtasks-2026.09.1", digest: contractDigest({ release: "smithtasks-2026.09.1" }) },
      implementation: { id: `${otherImplementation.id}@${otherImplementation.version}`, digest: contractDigest(otherImplementation) }, environments: ["test"]
    })).toThrow(expect.objectContaining({ code: "CS-POLICY-EVIDENCE-003" }));
  });

  test("rejects incomplete suites and untested implementation or environment claims", async () => {
    const action = await loadAction("reschedule-task");
    const evidence = evidenceFor(action);
    const implementation = evidence.implementations[0]!;
    const options = {
      release: { id: evidence.release.id, digest: evidence.release.digest },
      implementation: { id: `${implementation.id}@${implementation.version}`, digest: contractDigest(implementation) },
      environments: ["test"]
    };
    const incomplete = structuredClone(evidence);
    incomplete.runs = incomplete.runs.filter((run) => !run.scenario.id.endsWith(":conflict"));
    const { manifestDigest: _digest, ...unsigned } = incomplete;
    incomplete.manifestDigest = contractDigest(unsigned);
    expect(() => compilePolicy(action, incomplete, options)).toThrow(expect.objectContaining({ code: "CS-POLICY-EVIDENCE-004" }));
    expect(() => compilePolicy(action, evidence, { ...options, implementation: { id: "untested@9", digest: contractDigest({ id: "untested" }) } }))
      .toThrow(expect.objectContaining({ code: "CS-POLICY-EVIDENCE-005" }));
    expect(() => compilePolicy(action, evidence, { ...options, environments: ["production"] }))
      .toThrow(expect.objectContaining({ code: "CS-POLICY-EVIDENCE-006" }));
  });
});
