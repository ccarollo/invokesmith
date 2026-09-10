import type {
  ActionContract,
  AuditContract,
  AuthorizationContract,
  ConfirmationContract,
  EffectsContract,
  ErrorContract,
  IdempotencyContract,
  JsonSchema,
  JsonValue,
  ScenarioContract
} from "../../contract/src/index.js";
import { contractDigest } from "./canonicalize.js";

export const IR_VERSION = "invokesmith.ir/v0alpha1" as const;

export interface IntermediateAction {
  irVersion: typeof IR_VERSION;
  source: {
    apiVersion: ActionContract["apiVersion"];
    digest: string;
  };
  id: string;
  version: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  errors: ErrorContract[];
  authorization: AuthorizationContract;
  effects: EffectsContract & { mutating: boolean };
  confirmation: ConfirmationContract;
  idempotency: IdempotencyContract;
  audit: AuditContract;
  scenarios: ScenarioContract[];
  targetOverrides: Record<string, Record<string, JsonValue>>;
}

function sortedUnique(values: string[] | undefined): string[] | undefined {
  return values ? [...values].sort((left, right) => left.localeCompare(right)) : undefined;
}

export function lowerActionContract(contract: ActionContract): IntermediateAction {
  const classifications = [...contract.spec.effects.classifications].sort((left, right) => left.localeCompare(right));
  const effects: IntermediateAction["effects"] = {
    classifications,
    description: contract.spec.effects.description,
    mutating: classifications.some((value) => value !== "read_only")
  };
  if (contract.spec.effects.compensationAction !== undefined) effects.compensationAction = contract.spec.effects.compensationAction;
  if (contract.spec.effects.recoveryWindow !== undefined) effects.recoveryWindow = contract.spec.effects.recoveryWindow;

  const confirmation: ConfirmationContract = { required: contract.spec.confirmation.required };
  if (contract.spec.confirmation.prompt !== undefined) confirmation.prompt = contract.spec.confirmation.prompt;
  const facts = sortedUnique(contract.spec.confirmation.facts);
  if (facts !== undefined) confirmation.facts = facts;

  const idempotency: IdempotencyContract = {
    mode: contract.spec.idempotency.mode,
    retrySafe: contract.spec.idempotency.retrySafe
  };
  if (contract.spec.idempotency.keyField !== undefined) idempotency.keyField = contract.spec.idempotency.keyField;

  return {
    irVersion: IR_VERSION,
    source: { apiVersion: contract.apiVersion, digest: contractDigest(contract) },
    id: contract.metadata.id,
    version: contract.metadata.version,
    title: contract.metadata.title,
    description: contract.spec.description,
    inputSchema: structuredClone(contract.spec.input),
    outputSchema: structuredClone(contract.spec.output),
    errors: structuredClone(contract.spec.errors).sort((left, right) => left.code.localeCompare(right.code)),
    authorization: {
      required: contract.spec.authorization.required,
      actor: contract.spec.authorization.actor,
      scopes: [...contract.spec.authorization.scopes].sort((left, right) => left.localeCompare(right))
    },
    effects,
    confirmation,
    idempotency,
    audit: structuredClone(contract.spec.audit),
    scenarios: structuredClone(contract.spec.scenarios).sort((left, right) => left.id.localeCompare(right.id)),
    targetOverrides: structuredClone(contract.spec.targets ?? {})
  };
}
