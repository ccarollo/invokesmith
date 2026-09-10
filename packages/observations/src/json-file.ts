import { readFile } from "node:fs/promises";
import { canonicalize, contractDigest } from "../../compiler/src/index.js";
import type { JsonValue } from "../../contract/src/index.js";
import {
  OBSERVATION_PROVIDER_API_VERSION,
  type ObservationProvider,
  type ObservationRequest,
  type ObservationResponse,
  type ObservationSelector
} from "./types.js";

export class ObservationProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ObservationProviderError";
  }
}

function projectArray(values: unknown[], segments: string[]): unknown {
  return values.map((entry) => readPath(entry, segments));
}

function readPath(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  const [segment, ...rest] = segments;
  if (segment === undefined) return value;
  if (segment.endsWith("[]")) {
    const key = segment.slice(0, -2);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = (value as Record<string, unknown>)[key];
    return Array.isArray(entries) ? projectArray(entries, rest) : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return readPath((value as Record<string, unknown>)[segment], rest);
}

function observeSelector(state: unknown, selector: ObservationSelector): JsonValue {
  const value = readPath(state, selector.path.split(".").filter(Boolean));
  if (value === undefined) throw new ObservationProviderError("CS-OBS-003", `Observation path ${selector.path} does not exist.`);
  try {
    const canonical = canonicalize(value);
    return selector.projection === "digest" ? contractDigest(value) : JSON.parse(canonical) as JsonValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ObservationProviderError("CS-OBS-004", `Observation path ${selector.path} is not JSON data: ${message}`);
  }
}

export class JsonFileObservationProvider implements ObservationProvider {
  readonly id = "invokesmith.smithtasks-json-file";
  readonly version = "0.1.0";

  constructor(private readonly file: string) {}

  async observe(request: ObservationRequest): Promise<ObservationResponse> {
    let state: unknown;
    try {
      state = JSON.parse(await readFile(this.file, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ObservationProviderError("CS-OBS-001", `Cannot read observation state: ${message}`);
    }
    const facts = Object.fromEntries(request.selectors.map((selector) => [selector.id, observeSelector(state, selector)]));
    return {
      apiVersion: OBSERVATION_PROVIDER_API_VERSION,
      provider: { id: this.id, version: this.version },
      phase: request.phase,
      facts,
      redaction: "minimized"
    };
  }
}
