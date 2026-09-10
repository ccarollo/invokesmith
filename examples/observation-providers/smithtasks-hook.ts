import { HookObservationProvider, JsonFileObservationProvider } from "../../packages/observations/src/index.js";

/** Customer-side example: raw state stays in this process; only requested minimized facts are returned. */
export function createSmithTasksHook(stateFile: string): HookObservationProvider {
  const delegate = new JsonFileObservationProvider(stateFile);
  return new HookObservationProvider("example.smithtasks-hook", "1.0.0", async (request) => ({
    ...await delegate.observe(request),
    provider: { id: "example.smithtasks-hook", version: "1.0.0" }
  }));
}
