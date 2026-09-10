import type { JSONValue } from "@modelcontextprotocol/server";
import { getDefaultSmithTasksService, principalFromEnvironment, type DeleteTaskInput } from "../../../../packages/smithtasks-runtime/src/index.js";
import type { ToolInvocationContext } from "../server.js";

export async function handle(input: unknown, invocation: ToolInvocationContext): Promise<JSONValue> {
  const result = await getDefaultSmithTasksService().delete(input as DeleteTaskInput, {
    principal: principalFromEnvironment(),
    contractDigest: invocation.contractDigest,
    confirmationAccepted: invocation.confirmationAccepted
  });
  return result as JSONValue;
}
