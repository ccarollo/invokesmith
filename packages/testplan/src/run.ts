import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { canonicalize, contractDigest } from "../../compiler/src/index.js";
import {
  JsonFileObservationProvider,
  OBSERVATION_PROVIDER_API_VERSION,
  type ObservationProvider,
  ObservationProviderError,
  type ObservationRequest,
  type ObservationResponse,
  type ObservationSelector
} from "../../observations/src/index.js";
import { createSmithTasksFixture } from "../../smithtasks-runtime/src/index.js";
import type { JsonValue } from "../../contract/src/index.js";
import type { ScenarioPlan } from "./types.js";

export const OUTCOME_RESULT_VERSION = "invokesmith.outcome-result/v0alpha1" as const;

export type AssertionClassification = "response" | "authoritative_state" | "security" | "structural";
export type AssertionStatus = "passed" | "failed";
export type OutcomeFailureClass = "harness" | "environment" | "target" | "action" | "provider" | "assertion";

export interface OutcomeFailure {
  code: string;
  step: string;
  source: string;
  message: string;
  remediation: string;
}

export interface OutcomeAssertion {
  id: string;
  classification: AssertionClassification;
  status: AssertionStatus;
  message: string;
  source: "mcp-response" | "mcp-target" | "observation-provider" | "harness";
  expected?: JsonValue;
  actual?: JsonValue;
}

export interface ScenarioRunResult {
  apiVersion: typeof OUTCOME_RESULT_VERSION;
  status: "passed" | "failed";
  action: ScenarioPlan["action"];
  scenario: ScenarioPlan["scenario"];
  planDigest: string;
  fixture: { id: string; digest: string };
  environment: { runtime: "bun" | "node"; runtimeVersion: string; platform: NodeJS.Platform };
  target: { name: "mcp"; serverName: string; protocolVersion: string; implementationVersion: string };
  observationProvider: { id: string; version: string; redaction: "minimized" };
  assertions: OutcomeAssertion[];
  failureClass?: OutcomeFailureClass;
  failure?: OutcomeFailure;
}

export interface SmithTasksScenarioOptions {
  generatedServerDirectory: string;
  observationProvider?: (stateFile: string) => ObservationProvider;
  deliberateDefect?: "wrong-response" | "wrong-state" | "wrong-tenant" | "extra-mutation" | "missing-audit" | "provider-failure";
  cleanup?: (temporaryDirectory: string) => Promise<void>;
}

interface InvocationResult {
  result: "success" | "error";
  value: Record<string, JsonValue>;
  message?: string;
  targetFailure?: { code: string; message: string };
  target?: ScenarioRunResult["target"];
  confirmationPrompt?: string;
}

interface InvocationSequence {
  attempts: InvocationResult[];
  intermediate?: ObservationResponse;
  target?: ScenarioRunResult["target"];
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function selectors(plan: ScenarioPlan, phase: "before" | "after", invocation?: InvocationResult): ObservationSelector[] {
  const unchanged = strings(plan.expected.values.unchanged).map((path) => ({
    id: `unchanged:${path}`,
    path,
    projection: "digest" as const
  }));
  const generatedAudit = plan.variant === "retry" || plan.variant === "conflict"
    ? [
        { id: "internal:audit", path: "audit", projection: "value" as const },
        { id: "internal:tasks-digest", path: "tasks", projection: "digest" as const },
        { id: "internal:idempotency-digest", path: "idempotency", projection: "digest" as const },
        { id: "internal:audit-digest", path: "audit", projection: "digest" as const }
      ]
    : [];
  const changedTask = plan.action.id.endsWith(".reschedule") && typeof plan.invocation.input.taskId === "string"
    ? [{ id: "internal:changed-task", path: `tasks.${plan.invocation.input.taskId}`, projection: "value" as const }]
    : [];
  if (phase === "before") return [...unchanged, ...generatedAudit, ...changedTask];

  const state = Object.keys(object(plan.expected.values.state)).sort().map((path) => ({
    id: `state:${path}`,
    path,
    projection: "value" as const
  }));
  const audit = plan.expected.values.auditReceipt === true && typeof invocation?.value.auditReceipt === "string"
    ? [
        { id: "audit:receipts", path: "audit[].receipt", projection: "value" as const },
        { id: "internal:audit-events", path: "audit", projection: "value" as const }
      ]
    : [];
  const taskId = typeof plan.invocation.input.taskId === "string" ? plan.invocation.input.taskId : undefined;
  const recovery = typeof plan.expected.values.recoveryWindow === "string" && taskId
    ? [{ id: "internal:recoverable-until", path: `tasks.${taskId}.recoverableUntil`, projection: "value" as const }]
    : [];
  return [...unchanged, ...state, ...audit, ...recovery, ...generatedAudit, ...changedTask];
}

function observationRequest(plan: ScenarioPlan, phase: "before" | "between" | "after", requested: ObservationSelector[]): ObservationRequest {
  return {
    apiVersion: OBSERVATION_PROVIDER_API_VERSION,
    actionId: plan.action.id,
    scenarioId: plan.scenario.id,
    phase,
    selectors: requested
  };
}

function assertion(
  id: string,
  classification: AssertionClassification,
  passed: boolean,
  message: string,
  expected?: JsonValue,
  actual?: JsonValue
): OutcomeAssertion {
  const source = classification === "authoritative_state"
    ? "observation-provider"
    : classification === "structural"
      ? "harness"
      : classification === "security"
        ? id === "security.excludedTaskIds" || id === "idempotency.conflict" ? "mcp-response" : "mcp-target"
        : "mcp-response";
  return {
    id,
    classification,
    status: passed ? "passed" : "failed",
    message,
    source,
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {})
  };
}

function equal(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function evaluate(
  plan: ScenarioPlan,
  sequence: InvocationSequence,
  before: ObservationResponse,
  after: ObservationResponse
): OutcomeAssertion[] {
  const invocation = sequence.attempts.at(-1) ?? { result: "error" as const, value: {}, message: "No invocation result." };
  const assertions: OutcomeAssertion[] = [];
  assertions.push(assertion(
    "response.result",
    "response",
    invocation.result === plan.expected.result,
    `Expected ${plan.expected.result} and received ${invocation.result}.`,
    plan.expected.result,
    invocation.result
  ));

  const expectedTaskIds = strings(plan.expected.values.taskIds);
  if (expectedTaskIds.length > 0) {
    const tasks = Array.isArray(invocation.value.tasks) ? invocation.value.tasks : [];
    const actualTaskIds = tasks.flatMap((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.id === "string" ? [entry.id] : []);
    assertions.push(assertion(
      "response.taskIds",
      "response",
      equal(actualTaskIds, expectedTaskIds),
      "Returned task identities match the scenario.",
      expectedTaskIds,
      actualTaskIds
    ));
  }

  const excludedTaskIds = strings(plan.expected.values.excludedTaskIds);
  if (excludedTaskIds.length > 0) {
    const tasks = Array.isArray(invocation.value.tasks) ? invocation.value.tasks : [];
    const actualTaskIds = tasks.flatMap((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.id === "string" ? [entry.id] : []);
    const exposed = excludedTaskIds.filter((id) => actualTaskIds.includes(id));
    assertions.push(assertion(
      "security.excludedTaskIds",
      "security",
      exposed.length === 0,
      "Excluded task identities are not exposed.",
      [],
      exposed
    ));
  }

  for (const [path, expected] of Object.entries(object(plan.expected.values.state)).sort(([left], [right]) => left.localeCompare(right))) {
    const actual = after.facts[`state:${path}`];
    assertions.push(assertion(
      `state.${path}`,
      "authoritative_state",
      equal(actual, expected),
      `Authoritative state at ${path} matches the contract.`,
      expected,
      actual
    ));
    const responseField = path.split(".").at(-1);
    if (responseField && responseField in invocation.value) {
      assertions.push(assertion(
        `response.stateConsistency.${responseField}`,
        "authoritative_state",
        equal(invocation.value[responseField], actual),
        `Response field ${responseField} agrees with authoritative state.`,
        actual,
        invocation.value[responseField]
      ));
    }
  }

  for (const path of strings(plan.expected.values.unchanged).sort()) {
    const beforeDigest = before.facts[`unchanged:${path}`];
    const afterDigest = after.facts[`unchanged:${path}`];
    assertions.push(assertion(
      `state.${path}.unchanged`,
      "authoritative_state",
      beforeDigest === afterDigest,
      `Authoritative state at ${path} remains unchanged.`,
      beforeDigest,
      afterDigest
    ));
  }

  if (plan.action.id.endsWith(".reschedule")) {
    const beforeTask = structuredClone(object(before.facts["internal:changed-task"]));
    const afterTask = structuredClone(object(after.facts["internal:changed-task"]));
    delete beforeTask.dueAt;
    delete beforeTask.timeZone;
    delete afterTask.dueAt;
    delete afterTask.timeZone;
    assertions.push(assertion(
      "state.changedTask.exactPatch",
      "authoritative_state",
      equal(beforeTask, afterTask),
      "The changed task differs only in the contracted dueAt and timeZone fields.",
      beforeTask,
      afterTask
    ));
  }

  if (plan.expected.values.auditReceipt === true) {
    const receipt = invocation.value.auditReceipt;
    const receipts = after.facts["audit:receipts"];
    const passed = typeof receipt === "string" && Array.isArray(receipts) && receipts.includes(receipt);
    assertions.push(assertion(
      "state.auditReceipt",
      "authoritative_state",
      passed,
      "The returned audit receipt exists in authoritative audit state.",
      typeof receipt === "string" ? receipt : "required",
      Array.isArray(receipts) ? receipts : null
    ));
    const events = after.facts["internal:audit-events"];
    const matching = Array.isArray(events) ? events.find((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      return entry.receipt === receipt;
    }) : undefined;
    const taskId = typeof invocation.value.taskId === "string" ? invocation.value.taskId : undefined;
    const validMatch = matching && typeof matching === "object" && !Array.isArray(matching)
      && matching.taskId === taskId && matching.actionId === plan.action.id && matching.outcome === "success";
    assertions.push(assertion(
      "state.auditMatch",
      "authoritative_state",
      validMatch === true,
      "The audit event matches the response receipt, task, action, and successful outcome.",
      { receipt: typeof receipt === "string" ? receipt : "required", taskId: taskId ?? "required", actionId: plan.action.id, outcome: "success" },
      validMatch ? { receipt: String(matching.receipt), taskId: String(matching.taskId), actionId: String(matching.actionId), outcome: String(matching.outcome) } : null
    ));
  }

  if (typeof plan.expected.values.recoveryWindow === "string") {
    const deletedAt = typeof invocation.value.deletedAt === "string" ? Date.parse(invocation.value.deletedAt) : Number.NaN;
    const recoverableUntil = typeof invocation.value.recoverableUntil === "string" ? Date.parse(invocation.value.recoverableUntil) : Number.NaN;
    const days = (recoverableUntil - deletedAt) / (24 * 60 * 60 * 1000);
    assertions.push(assertion(
      "response.recoveryWindow",
      "response",
      plan.expected.values.recoveryWindow === "P30D" && days === 30,
      "The response preserves the contracted recovery window.",
      plan.expected.values.recoveryWindow,
      Number.isFinite(days) ? `P${days}D` : null
    ));
    assertions.push(assertion(
      "state.recoveryDeadline",
      "authoritative_state",
      typeof invocation.value.recoverableUntil === "string" && after.facts["internal:recoverable-until"] === invocation.value.recoverableUntil,
      "The response recovery deadline agrees with authoritative trash state.",
      invocation.value.recoverableUntil ?? null,
      after.facts["internal:recoverable-until"] ?? null
    ));
  }

  if (plan.invocation.confirmation === "accepted") {
    const taskId = typeof plan.invocation.input.taskId === "string" ? plan.invocation.input.taskId : undefined;
    const prompt = invocation.confirmationPrompt;
    assertions.push(assertion(
      "confirmation.informed",
      "security",
      typeof prompt === "string" && !prompt.includes("{{") && (!taskId || prompt.includes(taskId)),
      "The confirmation prompt identifies the intended action facts without unresolved placeholders.",
      taskId ?? "resolved prompt",
      prompt ?? null
    ));
  }

  if (plan.variant === "retry") {
    const [first, replay] = sequence.attempts;
    assertions.push(assertion(
      "idempotency.replayEquivalent",
      "response",
      first !== undefined && replay !== undefined && equal(first.value, replay.value),
      "A safe retry returns the original response.",
      first?.value ?? null,
      replay?.value ?? null
    ));
  }

  if (plan.variant === "conflict") {
    const [first, conflict] = sequence.attempts;
    const expectedCode = stringValue(plan.expected.values.errorCode);
    assertions.push(assertion(
      "idempotency.conflict",
      "security",
      first?.result === "success" && conflict?.result === "error" && (!expectedCode || conflict.message?.includes(expectedCode) === true),
      "Changed input with a reused idempotency key is rejected with the contracted conflict.",
      expectedCode ?? "error",
      conflict?.message ?? conflict?.result ?? null
    ));
  }

  if (plan.variant === "confirmation_rejected" || plan.variant === "confirmation_missing") {
    const expectedConfirmation = plan.variant === "confirmation_rejected" ? "rejected" : "missing";
    assertions.push(assertion(
      `confirmation.${expectedConfirmation}`,
      "security",
      plan.invocation.confirmation === expectedConfirmation && invocation.result === "error",
      `The target does not execute a destructive action when confirmation is ${expectedConfirmation}.`,
      `${expectedConfirmation} without execution`,
      invocation.result
    ));
  }

  if (plan.variant === "retry" || plan.variant === "conflict") {
    const beforeAudit = before.facts["internal:audit"];
    const afterAudit = after.facts["internal:audit"];
    const delta = Array.isArray(beforeAudit) && Array.isArray(afterAudit) ? afterAudit.length - beforeAudit.length : Number.NaN;
    assertions.push(assertion(
      "idempotency.singleMutation",
      "authoritative_state",
      delta === 1,
      "The two invocations produce exactly one audit-backed mutation.",
      1,
      Number.isFinite(delta) ? delta : null
    ));
    const invariantIds = ["internal:tasks-digest", "internal:idempotency-digest", "internal:audit-digest"];
    const changedAfterFirst = sequence.intermediate !== undefined && invariantIds.every((id) => sequence.intermediate?.facts[id] === after.facts[id]);
    assertions.push(assertion(
      "idempotency.noSecondMutation",
      "authoritative_state",
      changedAfterFirst,
      "Authoritative task, idempotency, and audit state remain unchanged after the second invocation.",
      true,
      changedAfterFirst
    ));
  }

  return assertions;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function invokeMcpOnce(
  plan: ScenarioPlan,
  directory: string,
  stateFile: string,
  input: Record<string, JsonValue>
): Promise<InvocationResult> {
  const transport = new StdioClientTransport({
    command: process.env.INVOKESMITH_BUN_BIN ?? "bun",
    args: ["run", "./src/server.ts"],
    cwd: directory,
    env: {
      ...getDefaultEnvironment(),
      INVOKESMITH_ACTOR_ID: "user-123",
      INVOKESMITH_ACTOR_TYPE: "user",
      INVOKESMITH_SCOPES: "tasks:read tasks:write tasks:delete",
      INVOKESMITH_SMITH_TASKS_STATE: stateFile
    },
    stderr: "pipe"
  });
  const capabilities = plan.invocation.confirmation === "missing" ? {} : { elicitation: { form: {} } };
  const client = new Client({ name: "invokesmith-outcome", version: "0.1.0" }, { capabilities });
  let confirmationPrompt: string | undefined;
  if (plan.invocation.confirmation !== "missing") {
    client.setRequestHandler("elicitation/create", async (request) => {
      confirmationPrompt = request.params.message;
      return plan.invocation.confirmation === "accepted"
        ? { action: "accept", content: { confirm: true } }
        : { action: "decline" };
    });
  }
  try {
    await client.connect(transport);
    const server = client.getServerVersion();
    const target: ScenarioRunResult["target"] = {
      name: "mcp",
      serverName: server?.name ?? "unknown",
      protocolVersion: client.getNegotiatedProtocolVersion() ?? "unknown",
      implementationVersion: server?.version ?? "unknown"
    };
    const discovered = await client.listTools();
    const tool = discovered.tools.find((entry) => entry.name === plan.action.id);
    const metadata = tool?._meta as Record<string, unknown> | undefined;
    if (!tool || metadata?.["invokesmith/contractDigest"] !== plan.action.contractDigest || metadata["invokesmith/actionVersion"] !== plan.action.version) {
      return {
        result: "error",
        value: {},
        message: `Discovered MCP tool identity does not match ${plan.action.id}.`,
        target,
        targetFailure: { code: "CS-TARGET-MCP-002", message: `Discovered MCP tool identity does not match ${plan.action.id}.` }
      };
    }
    const result = await client.callTool({ name: plan.action.id, arguments: input });
    const value = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
      ? result.structuredContent as Record<string, JsonValue>
      : {};
    if (result.isError) {
      const message = result.content.map((entry) => "text" in entry ? entry.text : "").filter(Boolean).join("\n");
      return { result: "error", value, message, target, ...(confirmationPrompt ? { confirmationPrompt } : {}) };
    }
    return { result: "success", value, target, ...(confirmationPrompt ? { confirmationPrompt } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: "error", value: {}, message, targetFailure: { code: "CS-TARGET-MCP-001", message } };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function invokeMcp(
  plan: ScenarioPlan,
  directory: string,
  stateFile: string,
  observeBetween: () => Promise<ObservationResponse>
): Promise<InvocationSequence> {
  const attempts = [await invokeMcpOnce(plan, directory, stateFile, plan.invocation.input)];
  const target = attempts[0]?.target;
  if (attempts[0]?.targetFailure) return { attempts, ...(target ? { target } : {}) };
  let intermediate: ObservationResponse | undefined;
  if (plan.variant === "retry" || plan.variant === "conflict") intermediate = await observeBetween();
  if (plan.variant === "retry") attempts.push(await invokeMcpOnce(plan, directory, stateFile, plan.invocation.input));
  if (plan.variant === "conflict" && plan.invocation.conflictInput) {
    attempts.push(await invokeMcpOnce(plan, directory, stateFile, plan.invocation.conflictInput));
  }
  return { attempts, ...(intermediate ? { intermediate } : {}), ...(target ? { target } : {}) };
}

function providerFailureResult(
  plan: ScenarioPlan,
  provider: ObservationProvider,
  step: "observe-before" | "observe-between" | "observe-after",
  error: unknown
): ScenarioRunResult {
  const known = error instanceof ObservationProviderError;
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...baseResult(plan, provider),
    status: "failed",
    assertions: [],
    failureClass: "provider",
    failure: {
      code: known ? error.code : "CS-OBS-999",
      step,
      source: provider.id,
      message,
      remediation: known ? "Correct the observation provider configuration or response, then reproduce this plan digest." : "Inspect the provider implementation and retry this plan digest."
    }
  };
}

function baseResult(
  plan: ScenarioPlan,
  provider: Pick<ObservationProvider, "id" | "version">,
  target: ScenarioRunResult["target"] = { name: "mcp", serverName: "unknown", protocolVersion: "unknown", implementationVersion: "unknown" }
): Omit<ScenarioRunResult, "status" | "assertions"> {
  const bunRuntime = "Bun" in globalThis && typeof (globalThis as { Bun?: { version?: unknown } }).Bun?.version === "string";
  return {
    apiVersion: OUTCOME_RESULT_VERSION,
    action: plan.action,
    scenario: plan.scenario,
    planDigest: plan.planDigest,
    fixture: { id: plan.fixture ?? "smithtasks-default", digest: contractDigest(createSmithTasksFixture()) },
    environment: { runtime: bunRuntime ? "bun" : "node", runtimeVersion: bunRuntime ? String((globalThis as { Bun: { version: string } }).Bun.version) : process.versions.node, platform: process.platform },
    target,
    observationProvider: { id: provider.id, version: provider.version, redaction: "minimized" }
  };
}

function actionErrorCode(message: string | undefined): string {
  if (!message) return "ACTION_FAILED";
  try {
    const value = JSON.parse(message) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value) && "code" in value && typeof value.code === "string") return value.code;
  } catch {
    // Non-JSON action failures retain the stable generic code.
  }
  return "ACTION_FAILED";
}

function appliesToPlan(plan: ScenarioPlan, defect: SmithTasksScenarioOptions["deliberateDefect"]): boolean {
  if (!defect || plan.variant !== "contract") return false;
  if (defect === "wrong-response" || defect === "provider-failure") return plan.action.id.endsWith(".search");
  return plan.action.id.endsWith(".reschedule");
}

async function injectStateDefect(stateFile: string, defect: SmithTasksScenarioOptions["deliberateDefect"]): Promise<void> {
  if (!defect || defect === "wrong-response" || defect === "provider-failure") return;
  const state = JSON.parse(await readFile(stateFile, "utf8")) as {
    tasks: Record<string, Record<string, JsonValue>>;
    audit: JsonValue[];
  };
  if (defect === "wrong-state" && state.tasks["task-123"]) state.tasks["task-123"].dueAt = "2026-09-16T09:00:00-05:00";
  if (defect === "wrong-tenant" && state.tasks["task-123"]) state.tasks["task-123"].tenantId = "tenant-private";
  if (defect === "extra-mutation" && state.tasks["task-private"]) state.tasks["task-private"].title = "Unexpected mutation";
  if (defect === "missing-audit") state.audit = [];
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function runSmithTasksScenario(plan: ScenarioPlan, options: SmithTasksScenarioOptions): Promise<ScenarioRunResult> {
  let root: string | undefined;
  let stateFile: string;
  try {
    root = await mkdtemp(join(tmpdir(), "invokesmith-outcome-"));
    stateFile = join(root, "smithtasks-state.json");
    await writeFile(stateFile, `${JSON.stringify(createSmithTasksFixture(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...baseResult(plan, { id: "unavailable", version: "0" }),
      status: "failed",
      assertions: [],
      failureClass: "environment",
      failure: {
        code: "CS-ENV-001",
        step: "setup",
        source: "outcome-runner",
        message,
        remediation: "Verify temporary-directory permissions and available storage, then reproduce this plan digest."
      }
    };
  }
  let provider: ObservationProvider;
  try {
    provider = options.observationProvider?.(stateFile) ?? new JsonFileObservationProvider(stateFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    return {
      ...baseResult(plan, { id: "unavailable", version: "0" }),
      status: "failed",
      assertions: [],
      failureClass: "harness",
      failure: {
        code: "CS-HARNESS-001",
        step: "configure-provider",
        source: "outcome-runner",
        message,
        remediation: "Correct the provider factory configuration and reproduce this plan digest."
      }
    };
  }
  const result = await (async (): Promise<ScenarioRunResult> => {
    if (appliesToPlan(plan, options.deliberateDefect) && options.deliberateDefect === "provider-failure") {
      return providerFailureResult(plan, provider, "observe-before", new ObservationProviderError("CS-DEMO-PROVIDER-001", "Deliberate provider failure for diagnostic verification."));
    }
    let before: ObservationResponse;
    try {
      before = await provider.observe(observationRequest(plan, "before", selectors(plan, "before")));
    } catch (error) {
      return providerFailureResult(plan, provider, "observe-before", error);
    }
    let invocation: InvocationSequence;
    try {
      invocation = await invokeMcp(
        plan,
        options.generatedServerDirectory,
        stateFile,
        () => provider.observe(observationRequest(plan, "between", selectors(plan, "before")))
      );
    } catch (error) {
      return providerFailureResult(plan, provider, "observe-between", error);
    }
    const targetFailure = invocation.attempts.find((attempt) => attempt.targetFailure)?.targetFailure;
    if (targetFailure) {
      return {
        ...baseResult(plan, provider, invocation.target),
        status: "failed",
        assertions: [],
        failureClass: "target",
        failure: {
          code: targetFailure.code,
          step: "invoke",
          source: "mcp",
          message: targetFailure.message,
          remediation: "Verify the generated MCP server path and runtime, then reproduce this plan digest."
        }
      };
    }
    if (appliesToPlan(plan, options.deliberateDefect) && options.deliberateDefect === "wrong-response") {
      const last = invocation.attempts.at(-1);
      if (last) last.value.tasks = [{ id: "task-456", title: "Roadmap planning decoy" }];
    }
    if (appliesToPlan(plan, options.deliberateDefect)) await injectStateDefect(stateFile, options.deliberateDefect);
    const lastInvocation = invocation.attempts.at(-1);
    let after: ObservationResponse;
    try {
      after = await provider.observe(observationRequest(plan, "after", selectors(plan, "after", lastInvocation)));
    } catch (error) {
      return providerFailureResult(plan, provider, "observe-after", error);
    }
    const assertions = evaluate(plan, invocation, before, after);
    const failed = assertions.some((entry) => entry.status === "failed");
    const finalInvocation = invocation.attempts.at(-1);
    const unexpectedActionFailure = plan.expected.result === "success" && finalInvocation?.result === "error";
    return {
      ...baseResult(plan, provider, invocation.target),
      status: failed ? "failed" : "passed",
      assertions,
      ...(failed ? {
        failureClass: unexpectedActionFailure ? "action" as const : "assertion" as const,
        failure: {
          code: unexpectedActionFailure ? actionErrorCode(finalInvocation?.message) : "CS-ASSERT-001",
          step: unexpectedActionFailure ? "invoke" : "assert",
          source: unexpectedActionFailure ? plan.action.id : plan.scenario.id,
          message: unexpectedActionFailure ? finalInvocation?.message ?? "Action failed." : `${assertions.filter((entry) => entry.status === "failed").length} outcome assertion(s) failed.`,
          remediation: unexpectedActionFailure ? "Inspect the application action error and reproduce this plan digest." : "Inspect the failed structured assertions and reproduce this plan digest."
        }
      } : {})
    };
  })();
  try {
    if (options.cleanup) await options.cleanup(root);
    else await rm(root, { recursive: true, force: true });
  } catch (error) {
    if (result.status === "failed") return result;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      status: "failed",
      failureClass: "environment",
      failure: {
        code: "CS-ENV-002",
        step: "cleanup",
        source: "outcome-runner",
        message,
        remediation: `Remove the temporary outcome directory ${root} and reproduce this plan digest.`
      }
    };
  }
  return result;
}
