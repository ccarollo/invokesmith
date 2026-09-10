import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ActionContract } from "../packages/contract/src/index.js";
import { contractDigest, lowerActionContract, validateActionContract } from "../packages/compiler/src/index.js";
import { createEvidenceManifest } from "../packages/evidence/src/index.js";
import { compilePolicy, type InvokeSmithPolicy } from "../packages/policy/src/index.js";
import { signArtifact } from "../packages/signing/src/index.js";
import { LocalPolicyDecisionClient, enforceSmithTasks, EnforcementError } from "../packages/enforcement/src/index.js";
import { createSmithTasksFixture, InMemoryStateStore, SmithTasksService } from "../packages/smithtasks-runtime/src/index.js";
import type { ScenarioRunResult } from "../packages/testplan/src/index.js";

async function policyFor(name: string): Promise<InvokeSmithPolicy> {
  const raw = JSON.parse(await readFile(new URL(`../examples/smithtasks/${name}.json`, import.meta.url), "utf8")) as ActionContract;
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
    assertions: [{ id: "outcome", classification: "authoritative_state", status: "passed", message: "proved", source: "observation-provider" }]
  };
  const releaseId = "smithtasks-2026.09.1";
  const scenarioIds = action.scenarios.flatMap((scenario) => [
    scenario.id,
    ...(action.idempotency.mode === "key_required" ? [`${scenario.id}:retry`, `${scenario.id}:conflict`] : []),
    ...(action.confirmation.required ? [`${scenario.id}:confirmation-rejected`, `${scenario.id}:confirmation-missing`] : [])
  ]);
  const evidence = createEvidenceManifest(scenarioIds.map((id, index) => ({ ...structuredClone(result), scenario: { ...result.scenario, id }, planDigest: `sha256:${String(index + 1).padStart(64, "0")}` })), { releaseId, environment: "test" });
  const implementation = evidence.implementations[0]!;
  return compilePolicy(action, evidence, {
    release: { id: releaseId, digest: evidence.release.digest }, implementation: { id: `${implementation.id}@${implementation.version}`, digest: contractDigest(implementation) }, environments: ["test"]
  });
}

function trusted(policy: InvokeSmithPolicy, options: { now?: string; revoked?: string[] } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    policyArtifact: signArtifact(policy, { artifactType: "policy" as const, keyId: "test-key", privateKey }),
    policyStatus: {
      publicKey,
      now: options.now ?? "2026-09-09T12:00:00Z",
      expectedContractDigest: policy.sources.contract.digest,
      expectedReleaseDigest: policy.sources.release.digest,
      ...(options.revoked ? { revokedPolicyDigests: options.revoked } : {})
    }
  };
}

function decisionRequest(policy: InvokeSmithPolicy, scope: string, extra: Record<string, unknown> = {}) {
  return {
    subject: { type: "user", id: "user-123", properties: { scopes: [scope], tenantId: "tenant-demo" } },
    action: { name: policy.action.id },
    resource: { type: "task", id: "task-123", properties: { ownerId: "user-123", tenantId: "tenant-demo" } },
    context: { invokesmith: {
      environment: "test", caller: { type: "user", id: "user-123" },
      policy: { digest: policy.policyDigest, releaseDigest: policy.sources.release.digest }, ...extra
    } }
  };
}

describe("SmithTasks enforcement point", () => {
  test("permits search, reschedule, and confirmed delete through PDP, PEP, and application boundaries", async () => {
    const cases = [
      ["search-tasks", "tasks:read", { query: "roadmap" }, {}],
      ["reschedule-task", "tasks:write", { taskId: "task-123", dueAt: "2026-09-15T09:00:00-05:00", timeZone: "America/Chicago", idempotencyKey: "01J7INVOKESMITHDEMO" }, { idempotencyKey: "01J7INVOKESMITHDEMO" }],
      ["delete-task", "tasks:delete", { taskId: "task-123", idempotencyKey: "01J7DELETEDEMO00" }, {
        idempotencyKey: "01J7DELETEDEMO00", confirmation: { accepted: true, subjectId: "user-123", actionId: "dev.smithtasks.tasks.delete", resourceId: "task-123", facts: ["input.taskId", "recoveryWindow"] }
      }]
    ] as const;
    for (const [name, scope, input, extension] of cases) {
      const policy = await policyFor(name);
      const service = new SmithTasksService(new InMemoryStateStore(createSmithTasksFixture()), () => new Date("2026-09-09T12:00:00Z"));
      const result = await enforceSmithTasks({ ...trusted(policy), request: decisionRequest(policy, scope, extension), input, service, decisionClient: new LocalPolicyDecisionClient() });
      expect(result).toMatchObject({ status: "executed", evidence: { policyDigest: policy.policyDigest, releaseDigest: policy.sources.release.digest, policyDecision: "allow", applicationDecision: "allow" } });
    }
  });

  test("fails closed before mutation for missing, malformed, mismatched, denied, or unavailable policy context", async () => {
    const policy = await policyFor("reschedule-task");
    const store = new InMemoryStateStore(createSmithTasksFixture());
    const service = new SmithTasksService(store);
    const input = { taskId: "task-123", dueAt: "2026-09-15T09:00:00-05:00", timeZone: "America/Chicago", idempotencyKey: "01J7INVOKESMITHDEMO" };
    const valid = decisionRequest(policy, "tasks:write", { idempotencyKey: "01J7INVOKESMITHDEMO" });
    const missing = structuredClone(valid); delete (missing.context.invokesmith as Record<string, unknown>).policy;
    const mismatch = structuredClone(valid); mismatch.context.invokesmith.policy = { digest: "sha256:wrong", releaseDigest: policy.sources.release.digest };
    const denied = decisionRequest(policy, "tasks:read", { idempotencyKey: "01J7INVOKESMITHDEMO" });
    const unavailable = { evaluate: async () => { throw new Error("offline"); } };
    const policyTrust = trusted(policy);

    for (const [request, client, code] of [
      [missing, new LocalPolicyDecisionClient(), "CS-ENFORCE-POLICY-CONTEXT-MISSING"],
      [mismatch, new LocalPolicyDecisionClient(), "CS-ENFORCE-POLICY-CONTEXT-MISMATCH"],
      [denied, new LocalPolicyDecisionClient(), "CS-ENFORCE-POLICY-DENIED"],
      [valid, { evaluate: async () => ({ decision: true } as never) }, "CS-ENFORCE-PDP-RESPONSE-MALFORMED"],
      [valid, unavailable, "CS-ENFORCE-PDP-UNAVAILABLE"]
    ] as const) {
      await expect(enforceSmithTasks({ ...policyTrust, request, input, service, decisionClient: client })).rejects.toMatchObject({ code, source: "policy" });
    }
    await expect(enforceSmithTasks({ ...policyTrust, request: valid, input: { ...input, taskId: "task-456" }, service, decisionClient: new LocalPolicyDecisionClient() }))
      .rejects.toMatchObject({ code: "CS-ENFORCE-RESOURCE-MISMATCH", source: "policy" });
    await expect(enforceSmithTasks({ ...policyTrust, request: valid, input: { ...input, idempotencyKey: "01J7OTHERKEYDEMO0" }, service, decisionClient: new LocalPolicyDecisionClient() }))
      .rejects.toMatchObject({ code: "CS-ENFORCE-IDEMPOTENCY-MISMATCH", source: "policy" });
    expect((await store.snapshot()).tasks["task-123"]?.dueAt).toBe("2026-09-10T09:00:00-04:00");
  });

  test("does not let a policy permit bypass application scope, owner, or tenant authority", async () => {
    const policy = await policyFor("reschedule-task");
    const request = decisionRequest(policy, "tasks:write", { idempotencyKey: "01J7INVOKESMITHDEMO" });
    const input = { taskId: "task-123", dueAt: "2026-09-15T09:00:00-05:00", timeZone: "America/Chicago", idempotencyKey: "01J7INVOKESMITHDEMO" };
    const service = new SmithTasksService(new InMemoryStateStore(createSmithTasksFixture()));
    const policyTrust = trusted(policy);

    const forgedOwner = structuredClone(request);
    forgedOwner.resource.id = "task-private";
    forgedOwner.resource.properties = { ownerId: "user-123", tenantId: "tenant-demo" };
    await expect(enforceSmithTasks({ ...policyTrust, request: forgedOwner, input: { ...input, taskId: "task-private" }, service, decisionClient: new LocalPolicyDecisionClient() }))
      .rejects.toMatchObject({ code: "TASK_NOT_FOUND", source: "application", policyDecision: "allow" });
    await expect(enforceSmithTasks({
      ...policyTrust, request, input, service, decisionClient: new LocalPolicyDecisionClient(),
      applicationPrincipal: { id: "user-123", actor: "user", scopes: [], tenantId: "tenant-demo" }
    })).rejects.toMatchObject({ code: "NOT_AUTHORIZED", source: "application", policyDecision: "allow" });
    const forgedTenant = structuredClone(request);
    forgedTenant.subject.properties.tenantId = "tenant-private";
    forgedTenant.resource.properties.tenantId = "tenant-private";
    await expect(enforceSmithTasks({ ...policyTrust, request: forgedTenant, input, service, decisionClient: new LocalPolicyDecisionClient() }))
      .rejects.toMatchObject({ code: "TASK_NOT_FOUND", source: "application", policyDecision: "allow" });
    await expect(enforceSmithTasks({ ...policyTrust, request, input, service, decisionClient: new LocalPolicyDecisionClient(), applicationPrincipal: { id: "user-private", actor: "user", scopes: ["tasks:write"], tenantId: "tenant-private" } }))
      .rejects.toMatchObject({ code: "CS-ENFORCE-PRINCIPAL-MISMATCH", source: "policy" });
  });

  test("uses an explicitly compiled allow-read-only posture only for unavailable read decisions", async () => {
    const policy = await policyFor("search-tasks");
    policy.runtime.unavailable = "allow_read_only";
    const { policyDigest: _oldDigest, ...unsigned } = policy;
    policy.policyDigest = contractDigest(unsigned);
    const request = decisionRequest(policy, "tasks:read");
    const service = new SmithTasksService(new InMemoryStateStore(createSmithTasksFixture()));
    const policyTrust = trusted(policy);
    const result = await enforceSmithTasks({ ...policyTrust, request, input: { query: "roadmap" }, service, decisionClient: { evaluate: async () => { throw new Error("offline"); } } });
    expect(result.evidence.policyDecision).toBe("allow");
    expect(result.output.tasks).toEqual(expect.any(Array));
    const crossTenant = structuredClone(request);
    crossTenant.resource.properties.tenantId = "other-tenant";
    await expect(enforceSmithTasks({ ...policyTrust, request: crossTenant, input: { query: "roadmap" }, service, decisionClient: { evaluate: async () => { throw new Error("offline"); } } }))
      .rejects.toMatchObject({ code: "CS-ENFORCE-POLICY-DENIED", source: "policy" });
  });

  test("rejects invalid signed policy lifecycle before a protected write", async () => {
    const policy = await policyFor("reschedule-task");
    const request = decisionRequest(policy, "tasks:write", { idempotencyKey: "01J7INVOKESMITHDEMO" });
    const input = { taskId: "task-123", dueAt: "2026-09-15T09:00:00-05:00", timeZone: "America/Chicago", idempotencyKey: "01J7INVOKESMITHDEMO" };
    const store = new InMemoryStateStore(createSmithTasksFixture());
    await expect(enforceSmithTasks({ ...trusted(policy, { revoked: [policy.policyDigest] }), request, input, service: new SmithTasksService(store), decisionClient: new LocalPolicyDecisionClient() }))
      .rejects.toMatchObject({ code: "CS-ENFORCE-POLICY-STATUS", source: "policy" });
    expect((await store.snapshot()).tasks["task-123"]?.dueAt).toBe("2026-09-10T09:00:00-04:00");
  });
});
