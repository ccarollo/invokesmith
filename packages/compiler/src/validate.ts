import type { ActionContract, EffectClassification, ErrorContract, ScenarioContract } from "../../contract/src/index.js";
import { diagnostic, type Diagnostic, type ValidationResult } from "./diagnostics.js";
import { validateAgainstContractSchema } from "./schema-validation.js";

const EFFECTS = new Set<EffectClassification>(["read_only", "reversible", "destructive", "financial", "external_communication", "open_world"]);

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function semanticValidation(contract: ActionContract, diagnostics: Diagnostic[]): void {
  const { spec } = contract;
  const classifications = spec.effects.classifications;
  const unknown = classifications.filter((entry) => !EFFECTS.has(entry));
  if (unknown.length > 0) diagnostics.push(diagnostic("CS-EFFECT-002", "error", "$.spec.effects.classifications", `Unknown effect classifications: ${unknown.join(", ")}.`));

  const readOnly = classifications.includes("read_only");
  const mutating = classifications.some((entry) => entry !== "read_only");
  const destructive = classifications.includes("destructive");
  const reversible = classifications.includes("reversible");

  if (readOnly && mutating) diagnostics.push(diagnostic("CS-EFFECT-004", "error", "$.spec.effects.classifications", "read_only cannot be combined with a mutating effect."));
  if (reversible && !spec.effects.compensationAction) diagnostics.push(diagnostic("CS-REVERSIBILITY-001", "error", "$.spec.effects.compensationAction", "A reversible action must identify its compensation action."));
  if (destructive && !spec.confirmation.required) diagnostics.push(diagnostic("CS-SAFETY-001", "error", "$.spec.confirmation.required", "A destructive action requires informed confirmation.", "Set required to true and describe the facts the user must see."));
  if (destructive && (!strings(spec.confirmation.facts) || spec.confirmation.facts.length === 0)) diagnostics.push(diagnostic("CS-SAFETY-002", "error", "$.spec.confirmation.facts", "A destructive action must declare at least one confirmation fact."));
  if (spec.confirmation.required && (!spec.confirmation.prompt || spec.confirmation.prompt.trim() === "")) diagnostics.push(diagnostic("CS-SAFETY-003", "error", "$.spec.confirmation.prompt", "A required confirmation needs a user-facing prompt."));
  if (mutating && (!spec.authorization.required || spec.authorization.scopes.length === 0)) diagnostics.push(diagnostic("CS-AUTH-001", "error", "$.spec.authorization", "A mutating action requires authorization and at least one scope."));
  if (spec.idempotency.mode === "key_required" && !spec.idempotency.keyField) diagnostics.push(diagnostic("CS-IDEMPOTENCY-001", "error", "$.spec.idempotency.keyField", "key_required idempotency must identify the input field containing the key."));
  if (mutating && spec.idempotency.mode === "none") diagnostics.push(diagnostic("CS-IDEMPOTENCY-002", "warning", "$.spec.idempotency.mode", "This mutating action has no idempotency protection; automatic retries may duplicate its effect."));
  if (destructive && !spec.audit.receiptRequired) diagnostics.push(diagnostic("CS-AUDIT-001", "error", "$.spec.audit.receiptRequired", "A destructive action must produce an audit receipt."));

  validateErrors(spec.errors, diagnostics);
  validateScenarios(spec.scenarios, diagnostics);
}

function validateErrors(errors: ErrorContract[], diagnostics: Diagnostic[]): void {
  const seen = new Set<string>();
  errors.forEach((error, index) => {
    if (seen.has(error.code)) diagnostics.push(diagnostic("CS-ERROR-002", "error", `$.spec.errors[${index}].code`, `Duplicate error code ${error.code}.`));
    seen.add(error.code);
  });
}

function validateScenarios(scenarios: ScenarioContract[], diagnostics: Diagnostic[]): void {
  if (scenarios.length === 0) diagnostics.push(diagnostic("CS-SCENARIO-001", "warning", "$.spec.scenarios", "No behavioral scenarios are defined; only structural conformance can be tested."));
  const seen = new Set<string>();
  scenarios.forEach((scenario, index) => {
    if (seen.has(scenario.id)) diagnostics.push(diagnostic("CS-SCENARIO-003", "error", `$.spec.scenarios[${index}].id`, `Duplicate scenario id ${scenario.id}.`));
    seen.add(scenario.id);
  });
}

export function validateActionContract(input: unknown): ValidationResult<ActionContract> {
  const diagnostics = validateAgainstContractSchema(input);
  if (diagnostics.length > 0) return { diagnostics, valid: false };
  const value = input as ActionContract;
  semanticValidation(value, diagnostics);
  const valid = !diagnostics.some((entry) => entry.severity === "error");
  return valid ? { value, diagnostics, valid } : { diagnostics, valid };
}
