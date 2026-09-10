import { contractDigest } from "../../compiler/src/index.js";
import type { ScenarioRunResult } from "../../testplan/src/index.js";

export const EVIDENCE_MANIFEST_VERSION = "invokesmith.evidence-manifest/v0alpha1" as const;

export interface EvidenceRun {
  action: ScenarioRunResult["action"];
  scenario: ScenarioRunResult["scenario"];
  planDigest: string;
  fixture: ScenarioRunResult["fixture"];
  environment: ScenarioRunResult["environment"];
  target: ScenarioRunResult["target"];
  observationProvider: ScenarioRunResult["observationProvider"];
  status: ScenarioRunResult["status"];
  assertions: Array<{
    id: string;
    classification: ScenarioRunResult["assertions"][number]["classification"];
    status: ScenarioRunResult["assertions"][number]["status"];
    message: string;
    source: string;
    redaction: "minimized";
  }>;
  failureClass?: ScenarioRunResult["failureClass"];
  failure?: ScenarioRunResult["failure"];
}

export interface EvidenceManifest {
  apiVersion: typeof EVIDENCE_MANIFEST_VERSION;
  manifestDigest: string;
  release: { id: string; digest: string; environment: string };
  contracts: Array<{ id: string; version: string; digest: string }>;
  implementations: Array<{ target: string; id: string; version: string }>;
  environments: Array<{ runtime: string; runtimeVersion: string; platform: string }>;
  suite: { id: "smithtasks-outcomes"; resultCount: number };
  runs: EvidenceRun[];
}

function runEvidence(result: ScenarioRunResult): EvidenceRun {
  const assertions = result.assertions.map((assertion) => ({
    id: assertion.id,
    classification: assertion.classification,
    status: assertion.status,
    message: assertion.message,
    source: assertion.source === "observation-provider"
      ? result.observationProvider.id
      : assertion.source === "mcp-target"
        ? `${result.target.serverName}@${result.target.implementationVersion}`
        : assertion.source,
    redaction: "minimized" as const
  }));
  if (!assertions.some((assertion) => assertion.classification === "structural")) {
    assertions.push({
      id: "evidence.identities",
      classification: "structural",
      status: "passed",
      message: "Contract, plan, fixture, target, provider, and environment identities are present.",
      source: "harness",
      redaction: "minimized"
    });
  }
  return {
    action: structuredClone(result.action),
    scenario: structuredClone(result.scenario),
    planDigest: result.planDigest,
    fixture: structuredClone(result.fixture),
    environment: structuredClone(result.environment),
    target: structuredClone(result.target),
    observationProvider: structuredClone(result.observationProvider),
    status: result.status,
    assertions: assertions.sort((left, right) => left.id.localeCompare(right.id)),
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    ...(result.failure ? { failure: structuredClone(result.failure) } : {})
  };
}

export function createEvidenceManifest(
  results: ScenarioRunResult[],
  options: { releaseId?: string; releaseDigest?: string; environment?: string } = {}
): EvidenceManifest {
  const runs = results.map(runEvidence).sort((left, right) =>
    left.action.id.localeCompare(right.action.id) || left.scenario.id.localeCompare(right.scenario.id));
  const contracts = [...new Map(runs.map((run) => [
    `${run.action.id}:${run.action.contractDigest}`,
    { id: run.action.id, version: run.action.version, digest: run.action.contractDigest }
  ])).values()].sort((left, right) => left.id.localeCompare(right.id));
  const implementations = [...new Map(runs.map((run) => [
    `${run.target.name}:${run.target.serverName}:${run.target.implementationVersion}`,
    { target: run.target.name, id: run.target.serverName, version: run.target.implementationVersion }
  ])).values()].sort((left, right) => left.target.localeCompare(right.target) || left.id.localeCompare(right.id));
  const environments = [...new Map(runs.map((run) => [
    `${run.environment.runtime}:${run.environment.runtimeVersion}:${run.environment.platform}`,
    structuredClone(run.environment)
  ])).values()].sort((left, right) => left.runtime.localeCompare(right.runtime) || left.platform.localeCompare(right.platform));
  const unsigned = {
    apiVersion: EVIDENCE_MANIFEST_VERSION,
    release: {
      id: options.releaseId ?? "development",
      digest: options.releaseDigest ?? contractDigest({ release: options.releaseId ?? "development" }),
      environment: options.environment ?? "development"
    },
    contracts,
    implementations,
    environments,
    suite: { id: "smithtasks-outcomes" as const, resultCount: runs.length },
    runs
  };
  return { ...unsigned, manifestDigest: contractDigest(unsigned) };
}

export function verifyEvidenceManifest(manifest: EvidenceManifest): { valid: true } | { valid: false; expectedDigest: string } {
  const { manifestDigest, ...unsigned } = manifest;
  const expectedDigest = contractDigest(unsigned);
  return expectedDigest === manifestDigest ? { valid: true } : { valid: false, expectedDigest };
}
