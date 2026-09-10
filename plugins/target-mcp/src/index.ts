import type { IntermediateAction } from "../../../packages/compiler/src/index.js";
import {
  TARGET_PLUGIN_API_VERSION,
  assertGenerationPlan,
  type GeneratedFile,
  type GenerationPlan,
  type TargetFinding,
  type TargetPlugin
} from "../../../packages/plugin-sdk/src/index.js";

const PLUGIN_VERSION = "0.1.0";
const MCP_VERSION = "2025-11-25";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function symbol(id: string): string {
  return id.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}

function annotations(action: IntermediateAction): Record<string, boolean> {
  const classifications = action.effects.classifications;
  return {
    readOnlyHint: classifications.includes("read_only"),
    destructiveHint: classifications.includes("destructive"),
    idempotentHint: action.idempotency.retrySafe,
    openWorldHint: classifications.includes("open_world") || classifications.includes("external_communication")
  };
}

function toolDefinition(action: IntermediateAction): Record<string, unknown> {
  return {
    name: action.id,
    title: action.title,
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    annotations: annotations(action),
    _meta: {
      "invokesmith/actionVersion": action.version,
      "invokesmith/contractDigest": action.source.digest,
      "invokesmith/authorization": action.authorization,
      "invokesmith/effects": action.effects,
      "invokesmith/confirmation": action.confirmation,
      "invokesmith/idempotency": action.idempotency,
      "invokesmith/audit": action.audit
    }
  };
}

function findingsFor(action: IntermediateAction): TargetFinding[] {
  const findings: TargetFinding[] = [
    { code: "MCP-SCHEMA-PORTABLE", actionId: action.id, feature: "input-output-schema", support: "portable", severity: "info", message: "Input and output JSON Schemas are emitted directly as MCP tool schemas." },
    { code: "MCP-ANNOTATIONS-UNTRUSTED", actionId: action.id, feature: "effects", support: "informational", severity: "warning", message: "MCP tool annotations preserve effect hints, but clients must treat them as untrusted metadata." },
    { code: "MCP-AUTH-RUNTIME", actionId: action.id, feature: "authorization", support: "emulated", severity: "warning", message: "Required actor and scopes are preserved in metadata; the generated handler must enforce them at runtime." },
    { code: "MCP-SCENARIOS-HARNESS", actionId: action.id, feature: "behavioral-scenarios", support: "emulated", severity: "info", message: "Contract scenarios become conformance-test inputs because MCP tool discovery has no behavioral scenario field." }
  ];
  if (action.confirmation.required) findings.push({ code: "MCP-CONFIRMATION-ELICITATION", actionId: action.id, feature: "confirmation", support: "portable", severity: "info", message: "Confirmation is enforced through MCP elicitation; the SDK's compatibility layer also supports the next multi-round-trip input_required flow." });
  if (action.idempotency.mode === "key_required") findings.push({ code: "MCP-IDEMPOTENCY-RUNTIME", actionId: action.id, feature: "idempotency", support: "emulated", severity: "warning", message: `The ${action.idempotency.keyField ?? "declared"} key is schema-visible; durable deduplication belongs in the application handler.` });
  if (action.audit.receiptRequired) findings.push({ code: "MCP-AUDIT-RUNTIME", actionId: action.id, feature: "audit-receipt", support: "emulated", severity: "warning", message: "The output schema advertises the receipt; durable audit storage belongs in the application handler." });
  return findings;
}

function serverSource(actions: IntermediateAction[]): string {
  const imports = actions.map((action) => `import { handle as handle${symbol(action.id)} } from "./handlers/${slug(action.id)}.js";`).join("\n");
  const definitions = json(Object.fromEntries(actions.map((action) => [action.id, toolDefinition(action)])));
  const handlers = actions.map((action) => `  ${JSON.stringify(action.id)}: handle${symbol(action.id)}`).join(",\n");
  const registrations = actions.map((action) => {
    const confirmation = action.confirmation.required ? `
      let confirmationAccepted = false;
      const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, "confirm");
      if (confirmed?.confirm !== true) {
        const confirmationMessage = renderConfirmationPrompt(definition, input);
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: confirmationMessage,
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean", title: "Confirm" } },
                required: ["confirm"]
              }
            })
          }
        });
      }
      confirmationAccepted = true;` : `
      const confirmationAccepted = true;`;
    return `  {
    const definition = definitions[${JSON.stringify(action.id)}];
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: fromJsonSchema(definition.inputSchema, validator),
        outputSchema: fromJsonSchema(definition.outputSchema, validator),
        annotations: definition.annotations,
        _meta: definition._meta
      },
      async (input, ctx) => {${confirmation}
        try {
          const output = await handlers[definition.name]!(input, {
            actionId: definition.name,
            contractDigest: definition._meta["invokesmith/contractDigest"],
            confirmationAccepted,
            requiredScopes: definition._meta["invokesmith/authorization"].scopes
          });
          return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "ACTION_FAILED";
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] };
        }
      }
    );
  }`;
  }).join("\n\n");

  return `// Generated by InvokeSmith. Changes to this file will be overwritten.
import { pathToFileURL } from "node:url";
import { McpServer, acceptedContent, fromJsonSchema, inputRequired, type JSONValue } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
${imports}

export interface ToolInvocationContext {
  actionId: string;
  contractDigest: string;
  confirmationAccepted: boolean;
  requiredScopes: string[];
}
export type ToolHandler = (input: unknown, context: ToolInvocationContext) => Promise<JSONValue>;
export interface ServerIdentity { name: string; version: string; }
type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  _meta: Record<string, any>;
};

function renderConfirmationPrompt(definition: ToolDefinition, input: unknown): string {
  const prompt = definition._meta["invokesmith/confirmation"].prompt ?? "Confirm this action.";
  const inputRecord = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return prompt.replace(/\\{\\{([^}]+)\\}\\}/g, (_match: string, key: string) => {
    if (key === "recoveryWindow") return String(definition._meta["invokesmith/effects"].recoveryWindow ?? "unavailable");
    if (key.startsWith("input.")) {
      const value = inputRecord[key.slice("input.".length)];
      return typeof value === "string" || typeof value === "number" ? String(value) : "unavailable";
    }
    return "unavailable";
  });
}

export const definitions = ${definitions} as Record<string, ToolDefinition>;

const defaultHandlers: Record<string, ToolHandler> = {
${handlers}
};

export function createServer(
  overrides: Partial<Record<string, ToolHandler>> = {},
  identity: ServerIdentity = { name: "invokesmith-generated", version: "0.1.0" }
): McpServer {
  const server = new McpServer(identity);
  const validator = new AjvJsonSchemaValidator();
  const handlers = { ...defaultHandlers, ...overrides };

${registrations}

  return server;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) await serveStdio(() => createServer());
`;
}

function handlerSource(action: IntermediateAction): string {
  return `// This application-owned file is created once and preserved on regeneration.
import type { JSONValue } from "@modelcontextprotocol/server";

export async function handle(_input: unknown): Promise<JSONValue> {
  throw new Error(${JSON.stringify(`NOT_IMPLEMENTED: connect ${action.id} to the application service`)});
}
`;
}

function generatedTestSource(actions: IntermediateAction[]): string {
  const ids = actions.map((action) => action.id);
  const samples = Object.fromEntries(actions.map((action) => [action.id, {
    input: action.scenarios[0]?.input ?? {},
    output: sampleFromSchema(action.outputSchema)
  }]));
  return `// Generated by InvokeSmith. Verifies discovery, schemas, and executable handlers.
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type JSONValue } from "@modelcontextprotocol/server";
import { createServer, definitions } from "../src/server.js";

const expectedIds = ${json(ids)};
const samples = ${json(samples)} as Record<string, { input: Record<string, JSONValue>; output: JSONValue }>;
const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (closeables.length > 0) await closeables.pop()!.close(); });

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const overrides = Object.fromEntries(expectedIds.map((id) => [id, async () => samples[id]!.output]));
  const server = createServer(overrides);
  const client = new Client(
    { name: "invokesmith-conformance", version: "0.1.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { confirm: true } }));
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return client;
}

describe("generated MCP target", () => {
  test("exposes every contracted tool with exact schemas", async () => {
    const client = await connected();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...expectedIds].sort());
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toEqual(definitions[tool.name]!.inputSchema);
      expect(tool.outputSchema).toEqual(definitions[tool.name]!.outputSchema);
    }
  });

  for (const id of expectedIds) {
    test(\`invokes \${id} through an in-memory MCP client\`, async () => {
      const client = await connected();
      const result = await client.callTool({ name: id, arguments: samples[id]!.input });
      expect(result.structuredContent).toEqual(samples[id]!.output);
    });
  }
});
`;
}

function stdioTestSource(actions: IntermediateAction[]): string {
  const ids = actions.map((action) => action.id);
  return `// Generated by InvokeSmith. Starts the real stdio entrypoint and checks discovery.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio server starts and exposes every contracted tool", async () => {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "./src/server.ts"],
    cwd: projectRoot,
    stderr: "pipe"
  });
  const client = new Client({ name: "invokesmith-stdio-smoke", version: "0.1.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(${json(ids)});
  } finally {
    await client.close();
  }
});
`;
}

function sampleFromSchema(schema: Record<string, unknown>): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const declared = Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type;
  if (declared === "object" || schema.properties) {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
    return Object.fromEntries(required.map((key) => [key, sampleFromSchema(properties[key] ?? {})]));
  }
  if (declared === "array") return [];
  if (declared === "integer" || declared === "number") return typeof schema.minimum === "number" ? schema.minimum : 0;
  if (declared === "boolean") return true;
  if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "uri") return "https://example.com/";
  const minimum = typeof schema.minLength === "number" ? schema.minLength : 1;
  return "x".repeat(Math.max(1, minimum));
}

function packageSource(): string {
  return `${json({
    name: "invokesmith-generated-mcp-server",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { start: "bun run ./src/server.ts", test: "bun test", check: "tsc --noEmit" },
    dependencies: { "@modelcontextprotocol/server": "2.0.0", ajv: "8.20.0", "ajv-formats": "3.0.1" },
    devDependencies: { "@modelcontextprotocol/client": "2.0.0", "@types/bun": "1.3.4", typescript: "5.9.3" }
  })}\n`;
}

export const mcpTargetPlugin: TargetPlugin = {
  describe: () => ({ apiVersion: TARGET_PLUGIN_API_VERSION, name: "mcp", displayName: "Model Context Protocol", version: PLUGIN_VERSION, protocolVersion: MCP_VERSION }),
  analyze: (actions) => actions.flatMap(findingsFor).sort((left, right) => `${left.actionId}:${left.code}`.localeCompare(`${right.actionId}:${right.code}`)),
  generate(actions) {
    const ordered = [...actions].sort((left, right) => left.id.localeCompare(right.id));
    const findings = this.analyze(ordered);
    const files = ([
      { path: "package.json", contents: packageSource(), ownership: "managed" },
      { path: "tsconfig.json", contents: `${json({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: ["bun"] }, include: ["src/**/*.ts", "tests/**/*.ts"] })}\n`, ownership: "managed" },
      { path: "src/server.ts", contents: serverSource(ordered), ownership: "managed" },
      { path: "tool-definitions.json", contents: `${json(ordered.map(toolDefinition))}\n`, ownership: "managed" },
      { path: "invokesmith-manifest.json", contents: `${json({ generatedBy: `@invokesmith/target-mcp@${PLUGIN_VERSION}`, protocolVersion: MCP_VERSION, actions: ordered.map((action) => ({ id: action.id, version: action.version, digest: action.source.digest })) })}\n`, ownership: "managed" },
      { path: "semantic-loss-report.json", contents: `${json({ target: "mcp", protocolVersion: MCP_VERSION, findings })}\n`, ownership: "managed" },
      { path: "tests/generated-contracts.test.ts", contents: generatedTestSource(ordered), ownership: "managed" },
      { path: "tests/generated-stdio.test.ts", contents: stdioTestSource(ordered), ownership: "managed" },
      { path: "README.md", contents: "# Generated InvokeSmith MCP server\n\nRun `bun test` to verify discovery, schemas, and handler wiring. Implement the preserved files in `src/handlers/`, then run `bun run start`.\n", ownership: "managed" },
      ...ordered.map((action) => ({ path: `src/handlers/${slug(action.id)}.ts`, contents: handlerSource(action), ownership: "custom" as const }))
    ] satisfies GeneratedFile[]).sort((left, right) => left.path.localeCompare(right.path));
    const plan: GenerationPlan = { apiVersion: TARGET_PLUGIN_API_VERSION, target: "mcp", pluginVersion: PLUGIN_VERSION, contractDigests: Object.fromEntries(ordered.map((action) => [action.id, action.source.digest])), files, findings };
    assertGenerationPlan(plan);
    return plan;
  }
};

export default mcpTargetPlugin;
