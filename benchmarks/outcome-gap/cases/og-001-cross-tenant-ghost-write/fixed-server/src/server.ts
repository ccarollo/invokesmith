import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../../../../../../generated/smithtasks-mcp/src/server.js";

await serveStdio(() => createServer(
  {},
  { name: "outcome-gap-fixed", version: "0.1.0" }
));
