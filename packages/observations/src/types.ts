import type { JsonValue } from "../../contract/src/index.js";

export const OBSERVATION_PROVIDER_API_VERSION = "invokesmith.observation-provider/v0alpha1" as const;

export type ObservationPhase = "before" | "between" | "after";
export type ObservationProjection = "value" | "digest";

export interface ObservationSelector {
  id: string;
  path: string;
  projection: ObservationProjection;
}

export interface ObservationRequest {
  apiVersion: typeof OBSERVATION_PROVIDER_API_VERSION;
  actionId: string;
  scenarioId: string;
  phase: ObservationPhase;
  selectors: ObservationSelector[];
}

export interface HttpObservationRequest extends ObservationRequest {
  provider: { id: string; version: string };
}

export interface ObservationResponse {
  apiVersion: typeof OBSERVATION_PROVIDER_API_VERSION;
  provider: { id: string; version: string };
  phase: ObservationPhase;
  facts: Record<string, JsonValue>;
  redaction: "minimized";
}

export interface ObservationProvider {
  readonly id: string;
  readonly version: string;
  observe(request: ObservationRequest): Promise<ObservationResponse>;
}

export type ObservationHook = (request: ObservationRequest) => Promise<ObservationResponse>;
