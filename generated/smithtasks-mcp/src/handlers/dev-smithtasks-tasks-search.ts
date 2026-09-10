import type { JSONValue } from "@modelcontextprotocol/server";
import { getDefaultSmithTasksService, principalFromEnvironment, type SearchTasksInput } from "../../../../packages/smithtasks-runtime/src/index.js";
import type { ToolInvocationContext } from "../server.js";

export async function handle(input: unknown, invocation: ToolInvocationContext): Promise<JSONValue> {
  const result = await getDefaultSmithTasksService().search(input as SearchTasksInput, {
    principal: principalFromEnvironment(),
    contractDigest: invocation.contractDigest,
    confirmationAccepted: invocation.confirmationAccepted
  });
  return result as JSONValue;
}
