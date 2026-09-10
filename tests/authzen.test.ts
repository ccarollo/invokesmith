import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ActionContract } from "../packages/contract/src/index.js";
import { contractDigest, lowerActionContract, validateActionContract } from "../packages/compiler/src/index.js";
import { createEvidenceManifest } from "../packages/evidence/src/index.js";
import { compilePolicy, type InvokeSmithPolicy } from "../packages/policy/src/index.js";
import type { ScenarioRunResult } from "../packages/testplan/src/index.js";
import {
  createAuthzenHandler,
  evaluateAccess,
  parseAccessEvaluationRequest,
  type AccessEvaluationRequest
} from "../packages/authzen/src/index.js";

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
    release: { id: releaseId, digest: evidence.release.digest },
    implementation: { id: `${implementation.id}@${implementation.version}`, digest: contractDigest(implementation) },
    environments: ["test"]
  });
}

function request(policy: InvokeSmithPolicy, scopes: string[], extra: Record<string, unknown> = {}): AccessEvaluationRequest {
  return {
    subject: { type: "user", id: "user-123", properties: { scopes, tenantId: "tenant-demo" } },
    action: { name: policy.action.id },
    resource: { type: "task", id: "task-123", properties: { ownerId: "user-123", tenantId: "tenant-demo" } },
    context: { invokesmith: { environment: "test", ...extra } }
  };
}

describe("AuthZEN reference PDP", () => {
  test("returns a final Authorization API compatible search decision with minimized InvokeSmith context", async () => {
    const policy = await policyFor("search-tasks");
    const result = evaluateAccess(policy, request(policy, ["tasks:read"]));

    expect(result).toEqual({
      decision: true,
      context: { invokesmith: { decision: "allow", reason: "CS-AUTHZEN-ALLOW", policyDigest: policy.policyDigest, releaseDigest: policy.sources.release.digest } }
    });
  });

  test("denies missing scope, wrong actor, cross-tenant access, and invalid action", async () => {
    const policy = await policyFor("search-tasks");
    const cases = [
      request(policy, []),
      { ...request(policy, ["tasks:read"]), subject: { type: "service", id: "svc-1", properties: { scopes: ["tasks:read"], tenantId: "tenant-demo" } } },
      { ...request(policy, ["tasks:read"]), resource: { type: "task", id: "task-123", properties: { ownerId: "user-123", tenantId: "other-tenant" } } },
      { ...request(policy, ["tasks:read"]), action: { name: "dev.smithtasks.tasks.delete" } }
    ];
    expect(cases.map((entry) => evaluateAccess(policy, entry).decision)).toEqual([false, false, false, false]);
  });

  test("keeps approval-required and idempotency semantics in an explicit extension", async () => {
    const reschedule = await policyFor("reschedule-task");
    const deletion = await policyFor("delete-task");

    expect(evaluateAccess(reschedule, request(reschedule, ["tasks:write"], {
      caller: { type: "user", id: "user-123" }, idempotencyKey: "01J7INVOKESMITHDEMO"
    })).context?.invokesmith.decision).toBe("allow");
    expect(evaluateAccess(reschedule, request(reschedule, ["tasks:write"], {
      caller: { type: "user", id: "user-123" }
    }))).toMatchObject({ decision: false, context: { invokesmith: { decision: "deny", reason: "CS-AUTHZEN-IDEMPOTENCY-REQUIRED" } } });

    const approval = evaluateAccess(deletion, request(deletion, ["tasks:delete"], {
      caller: { type: "user", id: "user-123" }, idempotencyKey: "01J7DELETEDEMO00"
    }));
    expect(approval).toMatchObject({ decision: false, context: { invokesmith: { decision: "approval_required", reason: "CS-AUTHZEN-CONFIRMATION-REQUIRED" } } });

    const allowed = evaluateAccess(deletion, request(deletion, ["tasks:delete"], {
      caller: { type: "user", id: "user-123" }, idempotencyKey: "01J7DELETEDEMO00",
      confirmation: { accepted: true, subjectId: "user-123", actionId: deletion.action.id, resourceId: "task-123", facts: ["input.taskId", "recoveryWindow"] }
    }));
    expect(allowed).toMatchObject({ decision: true, context: { invokesmith: { decision: "allow" } } });
  });

  test("fails malformed HTTP requests safely at the standard endpoint and needs no hosted service", async () => {
    const policy = await policyFor("search-tasks");
    const handler = createAuthzenHandler(() => policy);
    const malformed = await handler(new Request("http://localhost/access/v1/evaluation", { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-request-id": "request-123" } }));
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toContain("CS-AUTHZEN-REQUEST-001");
    expect(malformed.headers.get("x-request-id")).toBe("request-123");

    const valid = await handler(new Request("http://localhost/access/v1/evaluation", {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": "request-456" }, body: JSON.stringify(request(policy, ["tasks:read"]))
    }));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ decision: true });
    expect(valid.headers.get("x-request-id")).toBe("request-456");

    const wrongType = await handler(new Request("http://localhost/access/v1/evaluation", { method: "POST", body: JSON.stringify(request(policy, ["tasks:read"])), headers: { "content-type": "text/plain" } }));
    expect(wrongType.status).toBe(400);
    expect(await wrongType.text()).toContain("CS-AUTHZEN-CONTENT-TYPE-001");
    expect(() => parseAccessEvaluationRequest({ ...request(policy, ["tasks:read"]), action: { name: policy.action.id, properties: [] } })).toThrow();
  });
});
