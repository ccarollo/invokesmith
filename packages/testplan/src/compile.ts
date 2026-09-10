import { contractDigest, matchesJsonSchema, type IntermediateAction } from "../../compiler/src/index.js";
import type { JsonValue, ScenarioContract } from "../../contract/src/index.js";
import { TEST_PLAN_VERSION, type ScenarioPlan } from "./types.js";

export class ScenarioPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ScenarioPlanError";
  }
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compileScenario(action: IntermediateAction, scenario: ScenarioContract): ScenarioPlan {
  if (!scenario.id.trim()) throw new ScenarioPlanError("CS-PLAN-001", "Scenario id must not be empty.");
  const expectedResult = stringValue(scenario.expect.result);
  if (expectedResult !== "success" && expectedResult !== "error") {
    throw new ScenarioPlanError("CS-PLAN-002", `Scenario ${scenario.id} must expect result success or error.`);
  }

  const fixture = stringValue(scenario.given?.fixture);
  const requestedConfirmation = stringValue(scenario.given?.confirmation);
  const confirmation = action.confirmation.required
    ? requestedConfirmation === "accepted" ? "accepted" : requestedConfirmation === "rejected" ? "rejected" : "missing"
    : "not_required";
  const withoutDigest = {
    apiVersion: TEST_PLAN_VERSION,
    action: { id: action.id, version: action.version, contractDigest: action.source.digest },
    scenario: { id: scenario.id, description: scenario.description },
    variant: "contract" as const,
    obligation: "contract.scenario" as const,
    ...(fixture ? { fixture } : {}),
    invocation: { input: structuredClone(scenario.input), confirmation },
    expected: { result: expectedResult, values: structuredClone(scenario.expect) },
    steps: [
      { id: "setup", kind: "setup" },
      { id: "observe-before", kind: "observe", phase: "before" },
      { id: "invoke", kind: "invoke" },
      { id: "observe-after", kind: "observe", phase: "after" },
      { id: "assert", kind: "assert" },
      { id: "cleanup", kind: "cleanup" }
    ]
  } satisfies Omit<ScenarioPlan, "planDigest">;

  return { ...withoutDigest, planDigest: contractDigest(withoutDigest) };
}

function redigest(plan: ScenarioPlan): ScenarioPlan {
  const { planDigest: _discarded, ...withoutDigest } = plan;
  return { ...withoutDigest, planDigest: contractDigest(withoutDigest) };
}

function conflictingInput(action: IntermediateAction, input: Record<string, JsonValue>): Record<string, JsonValue> {
  const keyField = action.idempotency.keyField;
  const properties = action.inputSchema.properties && typeof action.inputSchema.properties === "object" && !Array.isArray(action.inputSchema.properties)
    ? action.inputSchema.properties as Record<string, JsonValue>
    : {};
  const candidates = Object.keys(input).sort((left, right) => {
    if (left === "taskId") return -1;
    if (right === "taskId") return 1;
    return left.localeCompare(right);
  }).filter((key) => {
    if (key === keyField) return false;
    const schema = properties[key];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
    if ("const" in schema || "enum" in schema) return false;
    const value = input[key];
    if (typeof value === "string") return !("format" in schema) && !("pattern" in schema) && !("maxLength" in schema);
    if (typeof value === "boolean") return true;
    if (typeof value === "number") return !("maximum" in schema) && !("exclusiveMaximum" in schema);
    return false;
  });
  for (const candidate of candidates) {
    const changed = structuredClone(input);
    const value = changed[candidate];
    if (typeof value === "string") changed[candidate] = `${value}-conflict`;
    else if (typeof value === "number") changed[candidate] = value + 1;
    else if (typeof value === "boolean") changed[candidate] = !value;
    else continue;
    if (matchesJsonSchema(action.inputSchema, changed)) return changed;
  }
  throw new ScenarioPlanError("CS-PLAN-003", `Action ${action.id} has no schema-valid input mutation for an idempotency conflict. Add a contract scenario with an alternate valid input.`);
}

export function compileGeneratedSafetyPlans(action: IntermediateAction): ScenarioPlan[] {
  if (!action.effects.mutating || action.idempotency.mode !== "key_required") return [];
  const bases = compileScenarioPlans(action).filter((plan) => plan.expected.result === "success");
  const generated: ScenarioPlan[] = [];
  for (const base of bases) {
    if (action.idempotency.retrySafe) {
      generated.push(redigest({
        ...structuredClone(base),
        scenario: { id: `${base.scenario.id}:retry`, description: `Generated retry proof for ${base.scenario.id}.` },
        variant: "retry",
        obligation: "idempotency.retrySafe",
        expected: { ...structuredClone(base.expected), values: { ...structuredClone(base.expected.values), replayEquivalent: true, singleMutation: true } }
      }));
    }
    generated.push(redigest({
      ...structuredClone(base),
      scenario: { id: `${base.scenario.id}:conflict`, description: `Generated conflicting idempotency-key proof for ${base.scenario.id}.` },
      variant: "conflict",
      obligation: "idempotency.keyReuse",
      invocation: { ...structuredClone(base.invocation), conflictInput: conflictingInput(action, base.invocation.input) },
      expected: { result: "error", values: { errorCode: "IDEMPOTENCY_KEY_REUSED", singleMutation: true } }
    }));
    if (action.confirmation.required) {
      generated.push(redigest({
        ...structuredClone(base),
        scenario: { id: `${base.scenario.id}:confirmation-rejected`, description: `Generated rejected-confirmation proof for ${base.scenario.id}.` },
        variant: "confirmation_rejected",
        obligation: "confirmation.required",
        invocation: { input: structuredClone(base.invocation.input), confirmation: "rejected" },
        expected: { result: "error", values: { errorCode: "CONFIRMATION_REQUIRED", unchanged: ["tasks", "idempotency", "audit"] } }
      }));
      generated.push(redigest({
        ...structuredClone(base),
        scenario: { id: `${base.scenario.id}:confirmation-missing`, description: `Generated missing-confirmation proof for ${base.scenario.id}.` },
        variant: "confirmation_missing",
        obligation: "confirmation.required",
        invocation: { input: structuredClone(base.invocation.input), confirmation: "missing" },
        expected: { result: "error", values: { errorCode: "CONFIRMATION_REQUIRED", unchanged: ["tasks", "idempotency", "audit"] } }
      }));
    }
  }
  return generated;
}

export function compileScenarioPlans(action: IntermediateAction): ScenarioPlan[] {
  return action.scenarios
    .map((scenario) => compileScenario(action, scenario))
    .sort((left, right) => left.scenario.id.localeCompare(right.scenario.id));
}
