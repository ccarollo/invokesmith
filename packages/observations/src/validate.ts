import type { JsonValue } from "../../contract/src/index.js";
import { canonicalize } from "../../compiler/src/index.js";
import { ObservationProviderError } from "./json-file.js";
import { OBSERVATION_PROVIDER_API_VERSION, type ObservationRequest, type ObservationResponse } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonFacts(value: unknown): Record<string, JsonValue> | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  try {
    return JSON.parse(canonicalize(candidate)) as Record<string, JsonValue>;
  } catch {
    return undefined;
  }
}

export function validateObservationResponse(
  value: unknown,
  request: ObservationRequest,
  expectedProvider: { id: string; version: string },
  invalidCode: string,
  leakageCode: string
): ObservationResponse {
  const response = record(value);
  const provider = record(response?.provider);
  const facts = jsonFacts(response?.facts);
  if (
    response?.apiVersion !== OBSERVATION_PROVIDER_API_VERSION ||
    response.phase !== request.phase ||
    response.redaction !== "minimized" ||
    provider?.id !== expectedProvider.id ||
    provider.version !== expectedProvider.version ||
    !facts
  ) {
    throw new ObservationProviderError(invalidCode, "Observation provider returned an invalid or mismatched response. Return the declared API version, provider identity, phase, minimized redaction, and JSON facts.");
  }
  const allowed = new Set(request.selectors.map((selector) => selector.id));
  const unexpected = Object.keys(facts).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ObservationProviderError(leakageCode, `Observation provider returned undeclared facts (${unexpected.join(", ")}). Return only requested minimized facts.`);
  }
  const missing = request.selectors.map((selector) => selector.id).filter((key) => !(key in facts));
  if (missing.length > 0) {
    throw new ObservationProviderError(invalidCode, `Observation provider omitted requested facts (${missing.join(", ")}).`);
  }
  return response as unknown as ObservationResponse;
}
