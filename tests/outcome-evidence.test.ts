import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import type { ActionContract } from "../packages/contract/src/index.js";
import { lowerActionContract, validateActionContract } from "../packages/compiler/src/index.js";
import { compileGeneratedSafetyPlans, compileScenarioPlans, ScenarioPlanError } from "../packages/testplan/src/index.js";
import { runSmithTasksScenario } from "../packages/testplan/src/index.js";
import {
  HttpObservationProvider,
  HookObservationProvider,
  JsonFileObservationProvider,
  type ObservationRequest,
  OBSERVATION_PROVIDER_API_VERSION
} from "../packages/observations/src/index.js";
import { createEvidenceManifest, verifyEvidenceManifest } from "../packages/evidence/src/index.js";

async function loadAction(name: string): Promise<ActionContract> {
  const input = JSON.parse(await readFile(new URL(`../examples/smithtasks/${name}.json`, import.meta.url), "utf8")) as unknown;
  const result = validateActionContract(input);
  if (!result.valid || !result.value) throw new Error(`${name} reference action is invalid`);
  return result.value;
}

describe("outcome scenario plans", () => {
  test("compiles a contract scenario into a stable, identity-bearing plan", async () => {
    const action = lowerActionContract(await loadAction("search-tasks"));

    const first = compileScenarioPlans(action);
    const second = compileScenarioPlans(structuredClone(action));

    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      apiVersion: "invokesmith.test-plan/v0alpha1",
      action: { id: "dev.smithtasks.tasks.search", version: "0.1.0", contractDigest: action.source.digest },
      scenario: { id: "find-overdue-roadmap-task" },
      invocation: { input: { query: "roadmap", dueBefore: "2026-09-11T00:00:00-05:00" } },
      expected: { result: "success" }
    });
    expect(first[0]?.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("executes search through MCP and proves visibility without mutation", async () => {
    const action = lowerActionContract(await loadAction("search-tasks"));
    const plan = compileScenarioPlans(action)[0]!;

    const result = await runSmithTasksScenario(plan, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
    });

    expect(result.status).toBe("passed");
    expect(result.target).toMatchObject({ name: "mcp", serverName: "invokesmith-generated", protocolVersion: "2025-11-25", implementationVersion: "0.1.0" });
    expect(result.observationProvider.id).toBe("invokesmith.smithtasks-json-file");
    expect(result.assertions.filter((assertion) => assertion.status === "failed")).toEqual([]);
    expect(result.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "response.taskIds", classification: "response", status: "passed" }),
      expect.objectContaining({ id: "security.excludedTaskIds", classification: "security", status: "passed" }),
      expect.objectContaining({ id: "state.tasks.unchanged", classification: "authoritative_state", status: "passed" }),
      expect.objectContaining({ id: "state.audit.unchanged", classification: "authoritative_state", status: "passed" })
    ]));
  });

  test("proves a reschedule changed only the contracted schedule and created audit evidence", async () => {
    const action = lowerActionContract(await loadAction("reschedule-task"));
    const plan = compileScenarioPlans(action)[0]!;

    const result = await runSmithTasksScenario(plan, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
    });

    expect(result.status).toBe("passed");
    expect(result.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "state.tasks.task-123.dueAt", status: "passed" }),
      expect.objectContaining({ id: "state.tasks.task-123.timeZone", status: "passed" }),
      expect.objectContaining({ id: "state.tasks.task-123.title.unchanged", status: "passed" }),
      expect.objectContaining({ id: "state.changedTask.exactPatch", status: "passed" }),
      expect.objectContaining({ id: "state.tasks.task-private.unchanged", status: "passed" }),
      expect.objectContaining({ id: "state.auditReceipt", status: "passed" })
    ]));
  });

  test("proves an accepted destructive action is confirmed, recoverable, and isolated", async () => {
    const action = lowerActionContract(await loadAction("delete-task"));
    const plan = compileScenarioPlans(action)[0]!;

    const result = await runSmithTasksScenario(plan, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
    });

    expect(result.status).toBe("passed");
    expect(result.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "state.tasks.task-123.status", status: "passed", actual: "trash" }),
      expect.objectContaining({ id: "state.tasks.task-private.unchanged", status: "passed" }),
      expect.objectContaining({ id: "state.auditReceipt", status: "passed" }),
      expect.objectContaining({ id: "response.recoveryWindow", status: "passed", actual: "P30D" }),
      expect.objectContaining({ id: "confirmation.informed", status: "passed", actual: expect.stringContaining("task-123") })
    ]));
  });

  test("generates deterministic retry, conflict, and confirmation obligations from write contracts", async () => {
    const reschedule = lowerActionContract(await loadAction("reschedule-task"));
    const deletion = lowerActionContract(await loadAction("delete-task"));

    const first = [...compileGeneratedSafetyPlans(reschedule), ...compileGeneratedSafetyPlans(deletion)];
    const second = [...compileGeneratedSafetyPlans(reschedule), ...compileGeneratedSafetyPlans(deletion)];

    expect(second).toEqual(first);
    expect(first.map((plan) => [plan.action.id, plan.variant, plan.obligation])).toEqual([
      ["dev.smithtasks.tasks.reschedule", "retry", "idempotency.retrySafe"],
      ["dev.smithtasks.tasks.reschedule", "conflict", "idempotency.keyReuse"],
      ["dev.smithtasks.tasks.delete", "retry", "idempotency.retrySafe"],
      ["dev.smithtasks.tasks.delete", "conflict", "idempotency.keyReuse"],
      ["dev.smithtasks.tasks.delete", "confirmation_rejected", "confirmation.required"],
      ["dev.smithtasks.tasks.delete", "confirmation_missing", "confirmation.required"]
    ]);
  });

  test("proves generated retry and conflict cases against the real MCP target", async () => {
    const action = lowerActionContract(await loadAction("reschedule-task"));
    const plans = compileGeneratedSafetyPlans(action);
    const results = await Promise.all(plans.map((plan) => runSmithTasksScenario(plan, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
    })));

    expect(results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(results[0]?.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "idempotency.replayEquivalent", status: "passed" }),
      expect.objectContaining({ id: "idempotency.singleMutation", status: "passed" }),
      expect.objectContaining({ id: "idempotency.noSecondMutation", status: "passed" })
    ]));
    expect(results[1]?.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "idempotency.conflict", status: "passed" }),
      expect.objectContaining({ id: "idempotency.singleMutation", status: "passed" })
    ]));
  });

  test("proves destructive retry, conflict, and rejected confirmation without extra mutation", async () => {
    const action = lowerActionContract(await loadAction("delete-task"));
    const plans = compileGeneratedSafetyPlans(action);
    const results = [];
    for (const plan of plans) {
      results.push(await runSmithTasksScenario(plan, {
        generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
      }));
    }

    expect(results.map((result) => result.status)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(results[2]?.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "confirmation.rejected", classification: "security", status: "passed" }),
      expect.objectContaining({ id: "state.tasks.unchanged", status: "passed" }),
      expect.objectContaining({ id: "state.audit.unchanged", status: "passed" })
    ]));
    expect(results[3]?.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "confirmation.missing", classification: "security", status: "passed" }),
      expect.objectContaining({ id: "state.tasks.unchanged", status: "passed" })
    ]));
  });

  test("uses a versioned HTTP provider for a real end-to-end outcome run", async () => {
    let delegate: JsonFileObservationProvider | undefined;
    const requests: Array<Record<string, unknown>> = [];
    const fetchProvider = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        if (!delegate) return new Response("not ready", { status: 503 });
        const { provider: _provider, ...observation } = body;
        const response = await delegate.observe(observation as unknown as ObservationRequest);
        return Response.json({ ...response, provider: { id: "example.smithtasks-http", version: "1.0.0" } });
    };
    const action = lowerActionContract(await loadAction("reschedule-task"));
    const result = await runSmithTasksScenario(compileScenarioPlans(action)[0]!, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname,
      observationProvider(stateFile) {
        delegate = new JsonFileObservationProvider(stateFile);
        return new HttpObservationProvider({
          endpoint: "http://observation.example.test/observe",
          id: "example.smithtasks-http",
          version: "1.0.0",
          fetch: fetchProvider
        });
      }
    });

    expect(result.status).toBe("passed");
    expect(result.observationProvider.id).toBe("example.smithtasks-http");
    expect(requests[0]).toMatchObject({
      apiVersion: "invokesmith.observation-provider/v0alpha1",
      provider: { id: "example.smithtasks-http", version: "1.0.0" },
      scenarioId: "reschedule-across-time-zones",
      phase: "before"
    });
  });

  test("uses a customer TypeScript hook while keeping raw state out of results", async () => {
    const action = lowerActionContract(await loadAction("reschedule-task"));
    const result = await runSmithTasksScenario(compileScenarioPlans(action)[0]!, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname,
      observationProvider(stateFile) {
        const delegate = new JsonFileObservationProvider(stateFile);
        return new HookObservationProvider("example.smithtasks-hook", "1.0.0", async (request) => ({
          ...await delegate.observe(request),
          provider: { id: "example.smithtasks-hook", version: "1.0.0" }
        }));
      }
    });

    expect(result.status).toBe("passed");
    expect(JSON.stringify(result)).not.toContain("Private payroll review");
    expect(result.assertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "state.tasks.task-123.dueAt", status: "passed" }),
      expect.objectContaining({ id: "state.tasks.task-private.unchanged", status: "passed" })
    ]));
  });

  test("classifies provider leakage separately from a product outcome failure", async () => {
    const action = lowerActionContract(await loadAction("search-tasks"));
    const result = await runSmithTasksScenario(compileScenarioPlans(action)[0]!, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname,
      observationProvider() {
        return new HookObservationProvider("unsafe.hook", "1.0.0", async (request) => ({
          apiVersion: OBSERVATION_PROVIDER_API_VERSION,
          provider: { id: "unsafe.hook", version: "1.0.0" },
          phase: request.phase,
          facts: { ...Object.fromEntries(request.selectors.map(({ id }) => [id, "sha256:safe"])), secret: "must-not-leave" },
          redaction: "minimized"
        }));
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      failureClass: "provider",
      failure: { code: "CS-OBS-HOOK-004", step: "observe-before", source: "unsafe.hook" }
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leave");
  });

  test("keeps HTTP authentication, timeout, and malformed data diagnostics distinct", async () => {
    const request: ObservationRequest = {
      apiVersion: OBSERVATION_PROVIDER_API_VERSION,
      actionId: "example.action",
      scenarioId: "example-scenario",
      phase: "before",
      selectors: []
    };
    const provider = (fetchProvider: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, timeoutMs = 100) =>
      new HttpObservationProvider({ endpoint: "https://observer.invalid", id: "example.http", version: "1.0.0", fetch: fetchProvider, timeoutMs });

    await expect(provider(async () => new Response("unauthorized", { status: 401 })).observe(request))
      .rejects.toMatchObject({ code: "CS-OBS-HTTP-001" });
    await expect(provider(async () => new Response("not json", { status: 200 })).observe(request))
      .rejects.toMatchObject({ code: "CS-OBS-HTTP-004" });
    await expect(provider((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }), 1).observe(request)).rejects.toMatchObject({ code: "CS-OBS-HTTP-002" });
  });

  test("emits deterministic, verifiable evidence without raw state or action inputs", async () => {
    const results = [];
    for (const name of ["search-tasks", "reschedule-task", "delete-task"]) {
      const action = lowerActionContract(await loadAction(name));
      results.push(await runSmithTasksScenario(compileScenarioPlans(action)[0]!, {
        generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
      }));
    }

    const repeatedResults = [];
    for (const name of ["search-tasks", "reschedule-task", "delete-task"]) {
      const action = lowerActionContract(await loadAction(name));
      repeatedResults.push(await runSmithTasksScenario(compileScenarioPlans(action)[0]!, {
        generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
      }));
    }
    const first = createEvidenceManifest(results);
    const second = createEvidenceManifest(repeatedResults);

    expect(second).toEqual(first);
    expect(verifyEvidenceManifest(first)).toEqual({ valid: true });
    expect(first.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.runs).toHaveLength(3);
    const searchEvidence = first.runs.find((run) => run.action.id.endsWith(".search"));
    expect(searchEvidence?.assertions.find((assertion) => assertion.id === "security.excludedTaskIds")?.source).toBe("mcp-response");
    expect(JSON.stringify(first)).not.toContain("01J7DELETEDEMO00");
    expect(JSON.stringify(first)).not.toContain("Private payroll review");
  });

  test("reports stable plan, hook, action, and target diagnostics at their true source", async () => {
    const invalidAction = lowerActionContract(await loadAction("search-tasks"));
    invalidAction.scenarios[0]!.id = "";
    expect(() => compileScenarioPlans(invalidAction)).toThrow(ScenarioPlanError);
    try {
      compileScenarioPlans(invalidAction);
    } catch (error) {
      expect(error).toMatchObject({ code: "CS-PLAN-001" });
    }

    const request: ObservationRequest = {
      apiVersion: OBSERVATION_PROVIDER_API_VERSION,
      actionId: "example.action",
      scenarioId: "example",
      phase: "before",
      selectors: []
    };
    await expect(new HookObservationProvider("hook", "1", async () => { throw new Error("boom"); }).observe(request))
      .rejects.toMatchObject({ code: "CS-OBS-HOOK-002" });
    await expect(new HookObservationProvider("hook", "1", async () => new Promise(() => {}), 1).observe(request))
      .rejects.toMatchObject({ code: "CS-OBS-HOOK-001" });
    await expect(new HookObservationProvider("hook", "1", async () => ({}) as never).observe(request))
      .rejects.toMatchObject({ code: "CS-OBS-HOOK-003" });

    const reschedule = lowerActionContract(await loadAction("reschedule-task"));
    const actionFailurePlan = structuredClone(compileScenarioPlans(reschedule)[0]!);
    actionFailurePlan.invocation.input.taskId = "task-private";
    const actionFailure = await runSmithTasksScenario(actionFailurePlan, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname
    });
    expect(actionFailure).toMatchObject({ failureClass: "action", failure: { code: "TASK_NOT_FOUND", step: "invoke" } });

    const targetFailure = await runSmithTasksScenario(compileScenarioPlans(reschedule)[0]!, {
      generatedServerDirectory: "/definitely/missing/invokesmith-server"
    });
    expect(targetFailure).toMatchObject({ failureClass: "target", failure: { code: "CS-TARGET-MCP-001", step: "invoke" } });

    const harnessFailure = await runSmithTasksScenario(compileScenarioPlans(reschedule)[0]!, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname,
      observationProvider() { throw new Error("bad provider factory"); }
    });
    expect(harnessFailure).toMatchObject({ failureClass: "harness", failure: { code: "CS-HARNESS-001", step: "configure-provider" } });

    const search = lowerActionContract(await loadAction("search-tasks"));
    const cleanupFailure = await runSmithTasksScenario(compileScenarioPlans(search)[0]!, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname,
      async cleanup(directory) {
        await rm(directory, { recursive: true, force: true });
        throw new Error("cleanup verification failure");
      }
    });
    expect(cleanupFailure).toMatchObject({ failureClass: "environment", failure: { code: "CS-ENV-002", step: "cleanup" } });

    const originalFailure = await runSmithTasksScenario(compileScenarioPlans(search)[0]!, {
      generatedServerDirectory: new URL("../generated/smithtasks-mcp/", import.meta.url).pathname,
      deliberateDefect: "provider-failure",
      async cleanup(directory) {
        await rm(directory, { recursive: true, force: true });
        throw new Error("secondary cleanup failure");
      }
    });
    expect(originalFailure).toMatchObject({ failureClass: "provider", failure: { code: "CS-DEMO-PROVIDER-001" } });
  });
});
