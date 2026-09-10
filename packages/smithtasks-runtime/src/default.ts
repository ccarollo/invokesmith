import { resolve } from "node:path";
import { createSmithTasksFixture } from "./fixtures.js";
import { SmithTasksService } from "./service.js";
import { JsonFileStateStore } from "./store.js";
import type { Principal } from "./types.js";

let defaultService: SmithTasksService | undefined;

export function principalFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Principal {
  const actorValue = environment.INVOKESMITH_ACTOR_TYPE;
  const actor = actorValue === "service" || actorValue === "agent" ? actorValue : "user";
  return {
    id: environment.INVOKESMITH_ACTOR_ID ?? "anonymous",
    actor,
    scopes: (environment.INVOKESMITH_SCOPES ?? "").split(/[ ,]+/).map((scope) => scope.trim()).filter(Boolean),
    tenantId: environment.INVOKESMITH_TENANT_ID ?? "tenant-demo"
  };
}

export function getDefaultSmithTasksService(environment: NodeJS.ProcessEnv = process.env): SmithTasksService {
  if (!defaultService) {
    const path = environment.INVOKESMITH_SMITH_TASKS_STATE ?? resolve(process.cwd(), ".invokesmith", "smithtasks-state.json");
    defaultService = new SmithTasksService(new JsonFileStateStore(path, createSmithTasksFixture()));
  }
  return defaultService;
}
