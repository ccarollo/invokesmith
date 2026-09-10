import { ObservationProviderError } from "./json-file.js";
import { OBSERVATION_PROVIDER_API_VERSION, type HttpObservationRequest, type ObservationProvider, type ObservationRequest, type ObservationResponse } from "./types.js";
import { validateObservationResponse } from "./validate.js";

export interface HttpObservationProviderOptions {
  endpoint: string;
  id: string;
  version: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class HttpObservationProvider implements ObservationProvider {
  readonly id: string;
  readonly version: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpObservationProviderOptions) {
    this.id = options.id;
    this.version = options.version;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async observe(request: ObservationRequest): Promise<ObservationResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const body: HttpObservationRequest = { ...request, apiVersion: OBSERVATION_PROVIDER_API_VERSION, provider: { id: this.id, version: this.version } };
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.options.headers },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw new ObservationProviderError("CS-OBS-HTTP-001", "HTTP observation authentication failed. Verify the configured credential and provider authorization policy.");
      }
      if (!response.ok) {
        throw new ObservationProviderError("CS-OBS-HTTP-003", `HTTP observation provider returned ${response.status}. Check provider health and request logs.`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new ObservationProviderError("CS-OBS-HTTP-004", "HTTP observation provider returned malformed JSON.");
      }
      return validateObservationResponse(value, request, { id: this.id, version: this.version }, "CS-OBS-HTTP-004", "CS-OBS-HTTP-006");
    } catch (error) {
      if (error instanceof ObservationProviderError) throw error;
      if (controller.signal.aborted) throw new ObservationProviderError("CS-OBS-HTTP-002", `HTTP observation provider timed out after ${this.timeoutMs}ms.`);
      const message = error instanceof Error ? error.message : String(error);
      throw new ObservationProviderError("CS-OBS-HTTP-005", `HTTP observation provider could not be reached: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
