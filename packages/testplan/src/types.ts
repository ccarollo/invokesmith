import type { JsonValue } from "../../contract/src/index.js";

export const TEST_PLAN_VERSION = "invokesmith.test-plan/v0alpha1" as const;

export type ScenarioResultExpectation = "success" | "error";

export interface ScenarioPlanStep {
  id: string;
  kind: "setup" | "observe" | "invoke" | "assert" | "cleanup";
  phase?: "before" | "after";
}

export interface ScenarioPlan {
  apiVersion: typeof TEST_PLAN_VERSION;
  planDigest: string;
  action: {
    id: string;
    version: string;
    contractDigest: string;
  };
  scenario: {
    id: string;
    description: string;
  };
  variant: "contract" | "retry" | "conflict" | "confirmation_rejected" | "confirmation_missing";
  obligation: "contract.scenario" | "idempotency.retrySafe" | "idempotency.keyReuse" | "confirmation.required";
  fixture?: string;
  invocation: {
    input: Record<string, JsonValue>;
    confirmation: "accepted" | "rejected" | "missing" | "not_required";
    conflictInput?: Record<string, JsonValue>;
  };
  expected: {
    result: ScenarioResultExpectation;
    values: Record<string, JsonValue>;
  };
  steps: ScenarioPlanStep[];
}
