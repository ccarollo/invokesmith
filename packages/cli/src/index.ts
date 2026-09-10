#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, contractDigest, lowerActionContract, validateActionContract } from "../../compiler/src/index.js";
import type { Diagnostic } from "../../compiler/src/index.js";
import { mcpTargetPlugin } from "../../../plugins/target-mcp/src/index.js";
import { writeGenerationPlan } from "./write-plan.js";
import { compileGeneratedSafetyPlans, compileScenarioPlans, runSmithTasksScenario, type ScenarioRunResult } from "../../testplan/src/index.js";
import { createEvidenceManifest } from "../../evidence/src/index.js";
import type { EvidenceManifest } from "../../evidence/src/index.js";
import { compilePolicy, type InvokeSmithPolicy } from "../../policy/src/index.js";
import { evaluateAccess, parseAccessEvaluationRequest } from "../../authzen/src/index.js";
import { signArtifact, verifyPolicyEvidenceBinding, verifySignedArtifact, type SignedArtifact } from "../../signing/src/index.js";
import { assessPolicyStatus } from "../../policy-status/src/index.js";
import { makeReleaseDecision, verifySignedReleaseDecision, type ReleaseDecision } from "../../release/src/index.js";

const HELP = `InvokeSmith contract tools

Usage:
  invokesmith validate <contract.json> [contract.json ...] [--json]
  invokesmith canonicalize <contract.json>
  invokesmith digest <contract.json>
  invokesmith generate --target mcp --out <directory> <contract.json> [contract.json ...] [--json]
  invokesmith scenario compile <contract.json> [contract.json ...] [--json]
  invokesmith test --outcome [--server <directory>] [--evidence <file>] [--release <id>] [--environment <name>] <contract.json> [contract.json ...] [--json]
  invokesmith policy compile --evidence <file> --release <id> --implementation <id> [--environment <name>] [--expires <time>] [--out <file>] <contract.json> [--json]
  invokesmith policy status --key <public.pem> --now <time> --contract-digest <digest> --release-digest <digest> [--out <file>] <signed-policy.json> [--json]
  invokesmith authzen evaluate --policy <policy.json> --request <request.json> [--json]
  invokesmith artifact sign --type <policy|evidence|release_decision> --key <private.pem> --key-id <id> --out <file> <artifact.json>
  invokesmith artifact verify --key <public.pem> <signed-artifact.json> [--json]
  invokesmith release decide --policy <signed-policy> --evidence <signed-evidence> --key <public.pem> --now <time> --contract-digest <digest> --release-digest <digest> [--revocations <file>] [--replacements <file>] --approved-by <id> --decided-at <time> [--out <file>] [--json]
  invokesmith release verify --policy <signed-policy> --evidence <signed-evidence> --key <public.pem> --now <time> --contract-digest <digest> --release-digest <digest> [--revocations <file>] [--replacements <file>] <signed-decision.json> [--json]
  invokesmith help
`;

async function readJson(file: string): Promise<unknown> {
  const source = await readFile(file, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: invalid JSON: ${message}`);
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(file)), { recursive: true });
  await writeFile(resolve(file), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function formatDiagnostic(file: string, entry: Diagnostic): string {
  const help = entry.help ? `\n    help: ${entry.help}` : "";
  return `${entry.severity.toUpperCase()} ${entry.code} ${file}${entry.path}\n    ${entry.message}${help}`;
}

async function validate(files: string[], json: boolean): Promise<number> {
  const results = [];
  let hasErrors = false;

  for (const file of files) {
    const value = await readJson(file);
    const result = validateActionContract(value);
    hasErrors ||= !result.valid;
    results.push({ file, digest: contractDigest(value), ...result });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return hasErrors ? 1 : 0;
  }

  for (const result of results) {
    if (result.diagnostics.length === 0) {
      process.stdout.write(`PASS ${result.file}\n  ${result.digest}\n`);
      continue;
    }

    for (const entry of result.diagnostics) process.stdout.write(`${formatDiagnostic(result.file, entry)}\n`);
    process.stdout.write(`${result.valid ? "PASS" : "FAIL"} ${result.file}\n  ${result.digest}\n`);
  }

  return hasErrors ? 1 : 0;
}

function option(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
}

async function generate(rest: string[]): Promise<number> {
  const target = option(rest, "--target");
  const outputDirectory = option(rest, "--out");
  const jsonOutput = rest.includes("--json");
  if (!target) throw new Error("generate requires --target mcp");
  if (target !== "mcp") throw new Error(`unknown target ${target}`);
  if (!outputDirectory) throw new Error("generate requires --out <directory>");

  const consumed = new Set<number>();
  for (const name of ["--target", "--out"]) {
    const index = rest.indexOf(name);
    if (index >= 0) { consumed.add(index); consumed.add(index + 1); }
  }
  rest.forEach((entry, index) => { if (entry === "--json") consumed.add(index); });
  const files = rest.filter((_entry, index) => !consumed.has(index));
  if (files.length === 0) throw new Error("generate requires at least one contract file");

  const actions = [];
  for (const file of files) {
    const result = validateActionContract(await readJson(file));
    if (!result.valid || !result.value) {
      for (const entry of result.diagnostics) process.stderr.write(`${formatDiagnostic(file, entry)}\n`);
      return 1;
    }
    actions.push(lowerActionContract(result.value));
  }
  const plan = mcpTargetPlugin.generate(actions);
  const writes = await writeGenerationPlan(plan, outputDirectory);
  const result = { target, outputDirectory, actions: actions.map((action) => action.id), writes, findings: plan.findings };
  if (jsonOutput) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Generated ${target} target in ${outputDirectory}\n`);
    for (const write of writes) process.stdout.write(`  ${write.status.padEnd(9)} ${write.path}${write.ownership === "custom" ? " (custom)" : ""}\n`);
    const warnings = plan.findings.filter((finding) => finding.severity === "warning");
    process.stdout.write(`  ${plan.findings.length} semantic mapping findings (${warnings.length} warnings, 0 errors)\n`);
  }
  return 0;
}

async function loadActions(files: string[]) {
  const actions = [];
  for (const file of files) {
    const result = validateActionContract(await readJson(file));
    if (!result.valid || !result.value) {
      for (const entry of result.diagnostics) process.stderr.write(`${formatDiagnostic(file, entry)}\n`);
      return undefined;
    }
    actions.push(lowerActionContract(result.value));
  }
  return actions;
}

async function compileScenarios(rest: string[]): Promise<number> {
  const jsonOutput = rest.includes("--json");
  const files = rest.filter((entry) => entry !== "--json");
  if (files.length === 0) throw new Error("scenario compile requires at least one contract file");
  const actions = await loadActions(files);
  if (!actions) return 2;
  const plans = actions.flatMap(compileScenarioPlans);
  if (jsonOutput) process.stdout.write(`${JSON.stringify(plans, null, 2)}\n`);
  else {
    for (const plan of plans) {
      process.stdout.write(`PLAN ${plan.action.id} / ${plan.scenario.id}\n  ${plan.planDigest}\n`);
      for (const step of plan.steps) process.stdout.write(`  ${step.id.padEnd(16)} ${step.kind}${step.phase ? `:${step.phase}` : ""}\n`);
    }
  }
  return 0;
}

type DeliberateDefect = NonNullable<Parameters<typeof runSmithTasksScenario>[1]["deliberateDefect"]>;

function consumedOutcomeArguments(rest: string[]): { files: string[]; server: string; evidence: string; releaseId: string; environment: string; json: boolean; deliberateDefect?: DeliberateDefect } {
  if (!rest.includes("--outcome")) throw new Error("test currently requires --outcome");
  const server = resolve(option(rest, "--server") ?? "./generated/smithtasks-mcp");
  const evidence = resolve(option(rest, "--evidence") ?? "./.invokesmith/outcome-evidence.json");
  const consumed = new Set<number>();
  for (const name of ["--server", "--evidence", "--demo-defect", "--release", "--environment"]) {
    const index = rest.indexOf(name);
    if (index >= 0) {
      if (!rest[index + 1]) throw new Error(`${name} requires a value`);
      consumed.add(index);
      consumed.add(index + 1);
    }
  }
  rest.forEach((entry, index) => { if (entry === "--outcome" || entry === "--json") consumed.add(index); });
  const defectValue = option(rest, "--demo-defect");
  const allowed = ["wrong-response", "wrong-state", "wrong-tenant", "extra-mutation", "missing-audit", "provider-failure"] as const;
  if (defectValue && !allowed.includes(defectValue as DeliberateDefect)) throw new Error(`unknown --demo-defect ${defectValue}`);
  return {
    files: rest.filter((_entry, index) => !consumed.has(index)),
    server,
    evidence,
    releaseId: option(rest, "--release") ?? "development",
    environment: option(rest, "--environment") ?? "development",
    json: rest.includes("--json"),
    ...(defectValue ? { deliberateDefect: defectValue as DeliberateDefect } : {})
  };
}

async function outcome(rest: string[]): Promise<number> {
  const options = consumedOutcomeArguments(rest);
  if (options.files.length === 0) throw new Error("test --outcome requires at least one contract file");
  const actions = await loadActions(options.files);
  if (!actions) return 2;
  const plans = actions.flatMap((action) => [...compileScenarioPlans(action), ...compileGeneratedSafetyPlans(action)]);
  const results: ScenarioRunResult[] = [];
  for (const plan of plans) {
    results.push(await runSmithTasksScenario(plan, {
      generatedServerDirectory: options.server,
      ...(options.deliberateDefect ? { deliberateDefect: options.deliberateDefect } : {})
    }));
  }
  const manifest = createEvidenceManifest(results, { releaseId: options.releaseId, environment: options.environment });
  await mkdir(dirname(options.evidence), { recursive: true });
  await writeFile(options.evidence, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const failed = results.filter((result) => result.status === "failed");
  const infrastructureFailure = failed.some((result) => result.failureClass === "harness" || result.failureClass === "environment" || result.failureClass === "target" || result.failureClass === "provider");
  const output = {
    status: failed.length === 0 ? "passed" : "failed",
    runCount: results.length,
    failedCount: failed.length,
    evidence: { path: options.evidence, digest: manifest.manifestDigest },
    results
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    for (const result of results) {
      process.stdout.write(`${result.status === "passed" ? "PASS" : "FAIL"} ${result.action.id} / ${result.scenario.id}\n`);
      if (result.failure) process.stdout.write(`  ${result.failure.code} ${result.failure.message}\n  reproduce: invokesmith test --outcome --server ${options.server} ${options.files.join(" ")}\n`);
    }
    process.stdout.write(`Evidence ${manifest.manifestDigest}\n  ${options.evidence}\n`);
  }
  return infrastructureFailure ? 3 : failed.length > 0 ? 1 : 0;
}

function positional(rest: string[], valuedOptions: string[]): string[] {
  const consumed = new Set<number>();
  for (const name of valuedOptions) {
    const index = rest.indexOf(name);
    if (index >= 0) {
      if (!rest[index + 1]) throw new Error(`${name} requires a value`);
      consumed.add(index);
      consumed.add(index + 1);
    }
  }
  rest.forEach((entry, index) => { if (entry === "--json") consumed.add(index); });
  return rest.filter((_entry, index) => !consumed.has(index));
}

function requiredOption(rest: string[], name: string): string {
  const value = option(rest, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function policyCompile(rest: string[]): Promise<number> {
  const evidenceFile = requiredOption(rest, "--evidence");
  const releaseId = requiredOption(rest, "--release");
  const implementationId = requiredOption(rest, "--implementation");
  const files = positional(rest, ["--evidence", "--release", "--implementation", "--environment", "--expires", "--out"]);
  if (files.length !== 1 || !files[0]) throw new Error("policy compile requires exactly one contract file");
  const actions = await loadActions(files);
  if (!actions?.[0]) return 2;
  const evidence = await readJson(evidenceFile) as EvidenceManifest;
  const testedImplementation = evidence.implementations.find((entry) => implementationId === entry.id || implementationId === `${entry.id}@${entry.version}`);
  if (!testedImplementation) throw new Error(`--implementation ${implementationId} is not present in evidence`);
  const policy = compilePolicy(actions[0], evidence, {
    release: { id: releaseId, digest: contractDigest({ release: releaseId }) },
    implementation: { id: implementationId, digest: contractDigest(testedImplementation) },
    environments: [option(rest, "--environment") ?? "development"],
    ...(option(rest, "--expires") ? { expiresAt: option(rest, "--expires")! } : {})
  });
  const output = option(rest, "--out");
  if (output) await writeJson(output, policy);
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
  else {
    process.stdout.write(`POLICY ${policy.action.id}\n  ${policy.policyDigest}\n  release ${policy.sources.release.id}\n`);
    for (const obligation of policy.obligations) process.stdout.write(`  ${obligation.disposition.padEnd(13)} ${obligation.id}\n`);
    if (output) process.stdout.write(`  wrote ${resolve(output)}\n`);
  }
  return 0;
}

async function authzenEvaluate(rest: string[]): Promise<number> {
  const policy = await readJson(requiredOption(rest, "--policy")) as InvokeSmithPolicy;
  const request = parseAccessEvaluationRequest(await readJson(requiredOption(rest, "--request")));
  const result = evaluateAccess(policy, request);
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.decision ? "ALLOW" : "DENY"} ${result.context.invokesmith.reason}\n  policy ${result.context.invokesmith.policyDigest}\n  release ${result.context.invokesmith.releaseDigest}\n`);
  return result.decision ? 0 : 1;
}

async function artifactSign(rest: string[]): Promise<number> {
  const type = requiredOption(rest, "--type");
  if (!(["policy", "evidence", "release_decision"] as string[]).includes(type)) throw new Error(`unsupported artifact type ${type}`);
  const keyFile = requiredOption(rest, "--key");
  const output = requiredOption(rest, "--out");
  const files = positional(rest, ["--type", "--key", "--key-id", "--out"]);
  if (files.length !== 1 || !files[0]) throw new Error("artifact sign requires exactly one artifact file");
  const privateKey = createPrivateKey(await readFile(keyFile));
  const signed = signArtifact(await readJson(files[0]), { artifactType: type as "policy" | "evidence" | "release_decision", keyId: requiredOption(rest, "--key-id"), privateKey });
  await writeJson(output, signed);
  process.stdout.write(`SIGNED ${type} ${signed.payloadDigest}\n  key ${signed.keyId}\n  wrote ${resolve(output)}\n`);
  return 0;
}

async function artifactVerify(rest: string[]): Promise<number> {
  const files = positional(rest, ["--key"]);
  if (files.length !== 1 || !files[0]) throw new Error("artifact verify requires exactly one signed artifact file");
  const artifact = await readJson(files[0]) as SignedArtifact<unknown>;
  const result = verifySignedArtifact(artifact, { publicKey: createPublicKey(await readFile(requiredOption(rest, "--key"))) });
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.valid ? "VALID" : "INVALID"} ${result.valid ? artifact.payloadDigest : `${result.code} ${result.message}`}\n`);
  return result.valid ? 0 : 1;
}

async function policyStatus(rest: string[]): Promise<number> {
  const files = positional(rest, ["--key", "--now", "--contract-digest", "--release-digest", "--revocations", "--replacements", "--out"]);
  if (files.length !== 1 || !files[0]) throw new Error("policy status requires exactly one signed policy file");
  const signed = await readJson(files[0]) as SignedArtifact<InvokeSmithPolicy>;
  const revocations = option(rest, "--revocations") ? await readJson(option(rest, "--revocations")!) as string[] : undefined;
  const replacements = option(rest, "--replacements") ? await readJson(option(rest, "--replacements")!) as Record<string, string> : undefined;
  const result = assessPolicyStatus(signed, {
    publicKey: createPublicKey(await readFile(requiredOption(rest, "--key"))),
    now: requiredOption(rest, "--now"),
    expectedContractDigest: requiredOption(rest, "--contract-digest"),
    expectedReleaseDigest: requiredOption(rest, "--release-digest"),
    ...(revocations ? { revokedPolicyDigests: revocations } : {}),
    ...(replacements ? { replacements } : {})
  });
  if (option(rest, "--out")) await writeJson(option(rest, "--out")!, result);
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.valid ? "VALID" : "INVALID"} ${result.status}${result.valid ? "" : `\n  ${result.reason}\n  help: ${result.remediation}`}\n`);
  return result.valid ? 0 : 1;
}

async function releaseDecide(rest: string[]): Promise<number> {
  const signedPolicy = await readJson(requiredOption(rest, "--policy")) as SignedArtifact<InvokeSmithPolicy>;
  const signedEvidence = await readJson(requiredOption(rest, "--evidence")) as SignedArtifact<EvidenceManifest>;
  const publicKey = createPublicKey(await readFile(requiredOption(rest, "--key")));
  const policy = signedPolicy.payload;
  const evidence = signedEvidence.payload;
  const decidedAt = requiredOption(rest, "--decided-at");
  const assessedAt = requiredOption(rest, "--now");
  if (assessedAt !== decidedAt) throw new Error("CS-RELEASE-TIME-MISMATCH: --now must exactly equal --decided-at so lifecycle is assessed at the recorded decision time");
  const policySignature = verifySignedArtifact(signedPolicy, { publicKey });
  const evidenceSignature = verifySignedArtifact(signedEvidence, { publicKey });
  if (!policySignature.valid || !evidenceSignature.valid) throw new Error("release sources must have valid signatures for the trusted key");
  const binding = verifyPolicyEvidenceBinding(signedPolicy, signedEvidence, { policyPublicKey: publicKey, evidencePublicKey: publicKey });
  if (!binding.valid) throw new Error(`${binding.code}: ${binding.message}`);
  const revocations = option(rest, "--revocations") ? await readJson(option(rest, "--revocations")!) as string[] : undefined;
  const replacements = option(rest, "--replacements") ? await readJson(option(rest, "--replacements")!) as Record<string, string> : undefined;
  const policyStatus = assessPolicyStatus(signedPolicy, {
    publicKey,
    now: assessedAt,
    expectedContractDigest: requiredOption(rest, "--contract-digest"),
    expectedReleaseDigest: requiredOption(rest, "--release-digest"),
    ...(revocations ? { revokedPolicyDigests: revocations } : {}),
    ...(replacements ? { replacements } : {})
  });
  const decision = makeReleaseDecision(policy, evidence, {
    gate: { require: ["structural", "security", "outcome"] },
    policyStatus,
    approvedBy: requiredOption(rest, "--approved-by"),
    decidedAt
  });
  const output = option(rest, "--out");
  if (output) await writeJson(output, decision);
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  else {
    process.stdout.write(`${decision.status === "approved" ? "APPROVED" : "BLOCKED"} ${decision.sources.release.id}\n  ${decision.decisionDigest}\n`);
    for (const reason of decision.reasons) process.stdout.write(`  ${reason.code} ${reason.message}\n    help: ${reason.remediation}\n`);
  }
  return decision.status === "approved" ? 0 : 1;
}

async function releaseVerify(rest: string[]): Promise<number> {
  const files = positional(rest, ["--policy", "--evidence", "--key", "--now", "--contract-digest", "--release-digest", "--revocations", "--replacements"]);
  if (files.length !== 1 || !files[0]) throw new Error("release verify requires exactly one signed decision file");
  const signedDecision = await readJson(files[0]) as SignedArtifact<ReleaseDecision>;
  const signedPolicy = await readJson(requiredOption(rest, "--policy")) as SignedArtifact<InvokeSmithPolicy>;
  const signedEvidence = await readJson(requiredOption(rest, "--evidence")) as SignedArtifact<EvidenceManifest>;
  const publicKey = createPublicKey(await readFile(requiredOption(rest, "--key")));
  const binding = verifyPolicyEvidenceBinding(signedPolicy, signedEvidence, { policyPublicKey: publicKey, evidencePublicKey: publicKey });
  if (!binding.valid) throw new Error(`${binding.code}: ${binding.message}`);
  const revocations = option(rest, "--revocations") ? await readJson(option(rest, "--revocations")!) as string[] : undefined;
  const replacements = option(rest, "--replacements") ? await readJson(option(rest, "--replacements")!) as Record<string, string> : undefined;
  const policyStatus = assessPolicyStatus(signedPolicy, {
    publicKey,
    now: requiredOption(rest, "--now"),
    expectedContractDigest: requiredOption(rest, "--contract-digest"),
    expectedReleaseDigest: requiredOption(rest, "--release-digest"),
    ...(revocations ? { revokedPolicyDigests: revocations } : {}),
    ...(replacements ? { replacements } : {})
  });
  const result = verifySignedReleaseDecision(signedDecision, { publicKey, policy: signedPolicy.payload, evidence: signedEvidence.payload, policyStatus, expectedGate: { require: ["structural", "security", "outcome"] } });
  if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.valid ? "VALID" : "INVALID"} ${result.valid ? signedDecision.payload.decisionDigest : `${result.code} ${result.message}`}\n`);
  return result.valid ? 0 : 1;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    if (command === "validate") {
      const json = rest.includes("--json");
      const files = rest.filter((entry) => entry !== "--json");
      if (files.length === 0) throw new Error("validate requires at least one contract file");
      return await validate(files, json);
    }

    if (command === "canonicalize" || command === "digest") {
      if (rest.length !== 1 || rest[0] === undefined) throw new Error(`${command} requires exactly one contract file`);
      const value = await readJson(rest[0]);
      process.stdout.write(`${command === "canonicalize" ? canonicalize(value) : contractDigest(value)}\n`);
      return 0;
    }

    if (command === "generate") return await generate(rest);

    if (command === "scenario") {
      if (rest[0] !== "compile") throw new Error("scenario requires the compile subcommand");
      return await compileScenarios(rest.slice(1));
    }

    if (command === "test") return await outcome(rest);

    if (command === "policy") {
      if (rest[0] === "compile") return await policyCompile(rest.slice(1));
      if (rest[0] === "status") return await policyStatus(rest.slice(1));
      throw new Error("policy requires the compile or status subcommand");
    }

    if (command === "authzen") {
      if (rest[0] !== "evaluate") throw new Error("authzen requires the evaluate subcommand");
      return await authzenEvaluate(rest.slice(1));
    }

    if (command === "artifact") {
      if (rest[0] === "sign") return await artifactSign(rest.slice(1));
      if (rest[0] === "verify") return await artifactVerify(rest.slice(1));
      throw new Error("artifact requires the sign or verify subcommand");
    }

    if (command === "release") {
      if (rest[0] === "decide") return await releaseDecide(rest.slice(1));
      if (rest[0] === "verify") return await releaseVerify(rest.slice(1));
      throw new Error("release requires the decide or verify subcommand");
    }

    throw new Error(`unknown command ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error ? `${String(error.code)}: ` : "";
    process.stderr.write(`invokesmith: ${code}${message}\n\n${HELP}`);
    return 2;
  }
}

const entrypoint = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
const moduleFile = await realpath(fileURLToPath(import.meta.url)).catch(() => undefined);
if (entrypoint && entrypoint === moduleFile) process.exitCode = await main();
