export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  readonly [key: string]: JsonValue | undefined;
}

export type EffectClassification =
  | "read_only"
  | "reversible"
  | "destructive"
  | "financial"
  | "external_communication"
  | "open_world";

export type IdempotencyMode = "none" | "natural" | "key_required";

export interface ContractMetadata {
  id: string;
  version: string;
  title: string;
}

export interface AuthorizationContract {
  required: boolean;
  scopes: string[];
  actor: "user" | "service" | "agent";
}

export interface EffectsContract {
  classifications: EffectClassification[];
  description: string;
  compensationAction?: string;
  recoveryWindow?: string;
}

export interface ConfirmationContract {
  required: boolean;
  prompt?: string;
  facts?: string[];
}

export interface IdempotencyContract {
  mode: IdempotencyMode;
  keyField?: string;
  retrySafe: boolean;
}

export interface ErrorContract {
  code: string;
  description: string;
  retryable: boolean;
}

export interface AuditContract {
  receiptRequired: boolean;
}

export interface ScenarioContract {
  id: string;
  description: string;
  given?: Record<string, JsonValue>;
  input: Record<string, JsonValue>;
  expect: Record<string, JsonValue>;
}

export interface ActionSpec {
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  errors: ErrorContract[];
  authorization: AuthorizationContract;
  effects: EffectsContract;
  confirmation: ConfirmationContract;
  idempotency: IdempotencyContract;
  audit: AuditContract;
  scenarios: ScenarioContract[];
  targets?: Record<string, Record<string, JsonValue>>;
}

export interface ActionContract {
  apiVersion: "invokesmith.dev/v0alpha1";
  kind: "Action";
  metadata: ContractMetadata;
  spec: ActionSpec;
}
