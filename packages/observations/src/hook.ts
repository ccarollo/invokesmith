import type { ObservationHook, ObservationProvider, ObservationRequest, ObservationResponse } from "./types.js";
import { ObservationProviderError } from "./json-file.js";
import { validateObservationResponse } from "./validate.js";

export class HookObservationProvider implements ObservationProvider {
  constructor(
    readonly id: string,
    readonly version: string,
    private readonly hook: ObservationHook,
    private readonly timeoutMs = 5_000
  ) {}

  async observe(request: ObservationRequest): Promise<ObservationResponse> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.hook(structuredClone(request)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new ObservationProviderError("CS-OBS-HOOK-001", `Observation hook timed out after ${this.timeoutMs}ms.`)), this.timeoutMs);
        })
      ]);
      return validateObservationResponse(response, request, { id: this.id, version: this.version }, "CS-OBS-HOOK-003", "CS-OBS-HOOK-004");
    } catch (error) {
      if (error instanceof ObservationProviderError) throw error;
      throw new ObservationProviderError("CS-OBS-HOOK-002", "Observation hook threw an exception. Inspect customer-side hook logs using the scenario identity; exception details are not exported.");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
