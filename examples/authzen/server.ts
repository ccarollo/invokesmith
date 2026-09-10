import { readFile } from "node:fs/promises";
import { createAuthzenHandler } from "../../packages/authzen/src/index.js";
import type { InvokeSmithPolicy } from "../../packages/policy/src/index.js";

const policyFile = process.env.INVOKESMITH_POLICY;
if (!policyFile) throw new Error("Set INVOKESMITH_POLICY to a compiled policy JSON file.");
const policy = JSON.parse(await readFile(policyFile, "utf8")) as InvokeSmithPolicy;
const handler = createAuthzenHandler((request) => request.action.name === policy.action.id ? policy : undefined);

const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: handler });
process.stdout.write(`InvokeSmith AuthZEN reference PDP listening on ${server.url}\n`);
