import { sign, verify, type KeyLike } from "node:crypto";
import { canonicalize, contractDigest } from "../../compiler/src/index.js";
import { verifyEvidenceManifest, type EvidenceManifest } from "../../evidence/src/index.js";
import { verifyPolicyIdentity, type InvokeSmithPolicy } from "../../policy/src/index.js";

export const SIGNATURE_MANIFEST_VERSION = "invokesmith.signature/v0alpha1" as const;

export interface SignedArtifact<T> {
  apiVersion: typeof SIGNATURE_MANIFEST_VERSION;
  algorithm: "Ed25519";
  keyId: string;
  artifactType: "policy" | "evidence" | "release_decision";
  payloadDigest: string;
  payload: T;
  signature: string;
}

export interface SignatureVerification {
  valid: boolean;
  code?: "CS-SIGN-VERSION-UNSUPPORTED" | "CS-SIGN-ALGORITHM-UNSUPPORTED" | "CS-SIGN-CONTENT-CHANGED" | "CS-SIGN-INVALID";
  message?: string;
  remediation?: string;
}

function signedBytes(header: Omit<SignedArtifact<unknown>, "payload" | "signature">): Buffer {
  return Buffer.from(canonicalize(header), "utf8");
}

export function signArtifact<T>(
  payload: T,
  options: { artifactType: SignedArtifact<T>["artifactType"]; keyId: string; privateKey: KeyLike }
): SignedArtifact<T> {
  const payloadDigest = contractDigest(payload);
  const header = {
    apiVersion: SIGNATURE_MANIFEST_VERSION,
    algorithm: "Ed25519" as const,
    keyId: options.keyId,
    artifactType: options.artifactType,
    payloadDigest
  };
  const signature = sign(null, signedBytes(header), options.privateKey).toString("base64url");
  return { ...header, payload: structuredClone(payload), signature };
}

export function verifySignedArtifact<T>(artifact: SignedArtifact<T>, options: { publicKey: KeyLike }): SignatureVerification {
  if (artifact.apiVersion !== SIGNATURE_MANIFEST_VERSION) {
    return { valid: false, code: "CS-SIGN-VERSION-UNSUPPORTED", message: `Unsupported signature manifest ${String(artifact.apiVersion)}.`, remediation: "Use a supported InvokeSmith verifier or re-sign with v0alpha1." };
  }
  if (artifact.algorithm !== "Ed25519") {
    return { valid: false, code: "CS-SIGN-ALGORITHM-UNSUPPORTED", message: `Unsupported signature algorithm ${String(artifact.algorithm)}.`, remediation: "Re-sign using Ed25519." };
  }
  if (contractDigest(artifact.payload) !== artifact.payloadDigest) {
    return { valid: false, code: "CS-SIGN-CONTENT-CHANGED", message: "The signed artifact content no longer matches its digest.", remediation: "Reject the artifact and obtain an unmodified signed copy." };
  }
  const header = {
    apiVersion: artifact.apiVersion,
    algorithm: artifact.algorithm,
    keyId: artifact.keyId,
    artifactType: artifact.artifactType,
    payloadDigest: artifact.payloadDigest
  };
  try {
    if (!verify(null, signedBytes(header), options.publicKey, Buffer.from(artifact.signature, "base64url"))) {
      return { valid: false, code: "CS-SIGN-INVALID", message: "The artifact signature is invalid for this key.", remediation: `Use the trusted public key for ${artifact.keyId} or obtain a newly signed artifact.` };
    }
  } catch {
    return { valid: false, code: "CS-SIGN-INVALID", message: "The artifact signature could not be decoded or verified.", remediation: "Reject the artifact and obtain a valid signed copy." };
  }
  return { valid: true };
}

export function verifyPolicyEvidenceBinding(
  policy: SignedArtifact<InvokeSmithPolicy>,
  evidence: SignedArtifact<EvidenceManifest>,
  keys: { policyPublicKey: KeyLike; evidencePublicKey: KeyLike }
): { valid: true } | { valid: false; code: string; message: string } {
  if (policy.artifactType !== "policy" || evidence.artifactType !== "evidence") {
    return { valid: false, code: "CS-SIGN-BINDING-TYPE", message: "Expected signed policy and evidence artifacts." };
  }
  if (!verifySignedArtifact(policy, { publicKey: keys.policyPublicKey }).valid || !verifySignedArtifact(evidence, { publicKey: keys.evidencePublicKey }).valid) {
    return { valid: false, code: "CS-SIGN-BINDING-SIGNATURE", message: "Policy or evidence signature verification failed." };
  }
  if (!verifyPolicyIdentity(policy.payload).valid || !verifyEvidenceManifest(evidence.payload).valid) {
    return { valid: false, code: "CS-SIGN-BINDING-IDENTITY", message: "The signed policy or evidence contains an invalid internal identity." };
  }
  const contract = evidence.payload.contracts.find((entry) => entry.id === policy.payload.sources.contract.id);
  if (!contract || contract.digest !== policy.payload.sources.contract.digest) {
    return { valid: false, code: "CS-SIGN-BINDING-CONTRACT", message: "Policy and evidence do not reference the same contract." };
  }
  if (evidence.payload.release.id !== policy.payload.sources.release.id ||
      evidence.payload.release.digest !== policy.payload.sources.release.digest ||
      evidence.payload.manifestDigest !== policy.payload.sources.evidence.digest) {
    return { valid: false, code: "CS-SIGN-BINDING-RELEASE", message: "Policy and evidence do not reference the same evidence and release." };
  }
  const implementation = evidence.payload.implementations.find((entry) =>
    policy.payload.sources.implementation.id === entry.id || policy.payload.sources.implementation.id === `${entry.id}@${entry.version}`);
  if (!implementation || contractDigest(implementation) !== policy.payload.sources.implementation.digest ||
      evidence.payload.release.environment !== policy.payload.sources.evidence.environment ||
      !policy.payload.authorization.environments.includes(evidence.payload.release.environment)) {
    return { valid: false, code: "CS-SIGN-BINDING-IMPLEMENTATION", message: "Policy and evidence do not reference the same implementation and environment." };
  }
  const scenarioIds = new Set(policy.payload.sources.evidence.scenarioIds);
  const actionRuns = evidence.payload.runs.filter((run) =>
    run.action.id === policy.payload.sources.contract.id &&
    run.action.contractDigest === policy.payload.sources.contract.digest &&
    run.target.name === implementation.target &&
    run.target.serverName === implementation.id &&
    run.target.implementationVersion === implementation.version);
  if (scenarioIds.size !== policy.payload.sources.evidence.scenarioIds.length ||
      [...scenarioIds].some((scenarioId) => !actionRuns.some((run) => run.scenario.id === scenarioId && run.status === "passed"))) {
    return { valid: false, code: "CS-SIGN-BINDING-IMPLEMENTATION", message: "The selected implementation did not produce every required passing run for this action." };
  }
  return { valid: true };
}
