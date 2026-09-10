import type { KeyLike } from "node:crypto";
import { verifyPolicyIdentity, type InvokeSmithPolicy } from "../../policy/src/index.js";
import { verifySignedArtifact, type SignedArtifact } from "../../signing/src/index.js";

export type InvalidPolicyStatus =
  | "unsupported"
  | "malformed"
  | "modified"
  | "invalid_signature"
  | "stale_contract"
  | "stale_release"
  | "expired"
  | "revoked"
  | "replaced";

export type PolicyStatus =
  | { valid: true; status: "valid" }
  | { valid: false; status: InvalidPolicyStatus; reason: string; remediation: string };

export interface PolicyStatusOptions {
  publicKey: KeyLike;
  now: string;
  expectedContractDigest: string;
  expectedReleaseDigest: string;
  revokedPolicyDigests?: string[];
  replacements?: Record<string, string>;
}

export function assessPolicyStatus(artifact: SignedArtifact<InvokeSmithPolicy>, options: PolicyStatusOptions): PolicyStatus {
  if (artifact.artifactType !== "policy") {
    return { valid: false, status: "malformed", reason: "The signed artifact is not a policy.", remediation: "Provide a signed InvokeSmith policy artifact." };
  }
  const signature = verifySignedArtifact(artifact, { publicKey: options.publicKey });
  if (!signature.valid) {
    const status: InvalidPolicyStatus = signature.code === "CS-SIGN-VERSION-UNSUPPORTED" || signature.code === "CS-SIGN-ALGORITHM-UNSUPPORTED"
      ? "unsupported"
      : signature.code === "CS-SIGN-CONTENT-CHANGED" ? "modified" : "invalid_signature";
    return { valid: false, status, reason: signature.message ?? "Policy signature validation failed.", remediation: signature.remediation ?? "Obtain a trusted, supported policy artifact." };
  }
  const policy = artifact.payload;
  if (!verifyPolicyIdentity(policy).valid) {
    return { valid: false, status: "modified", reason: "The embedded policy identity does not match its content.", remediation: "Reject the policy and obtain a newly compiled and signed artifact." };
  }
  const now = Date.parse(options.now);
  if (!Number.isFinite(now)) {
    return { valid: false, status: "malformed", reason: "The policy-status clock value is invalid.", remediation: "Provide an ISO 8601 assessment time." };
  }
  if (options.revokedPolicyDigests?.includes(policy.policyDigest)) {
    return { valid: false, status: "revoked", reason: "The policy identity appears on the local revocation list.", remediation: "Load the currently approved replacement policy before executing." };
  }
  const replacement = options.replacements?.[policy.policyDigest];
  if (replacement) {
    return { valid: false, status: "replaced", reason: `The policy was replaced by ${replacement}.`, remediation: "Load and verify the named replacement policy." };
  }
  if (policy.lifecycle.expiresAt && !Number.isFinite(Date.parse(policy.lifecycle.expiresAt))) {
    return { valid: false, status: "malformed", reason: "The policy expiry value is invalid.", remediation: "Recompile and sign a policy with an ISO 8601 expiry." };
  }
  if (policy.lifecycle.expiresAt && now >= Date.parse(policy.lifecycle.expiresAt)) {
    return { valid: false, status: "expired", reason: `The policy expired at ${policy.lifecycle.expiresAt}.`, remediation: "Compile and approve a policy with a current validity period." };
  }
  if (policy.sources.contract.digest !== options.expectedContractDigest) {
    return { valid: false, status: "stale_contract", reason: "The policy was compiled from a different protected contract digest.", remediation: "Re-run outcome tests and compile policy from the current contract." };
  }
  if (policy.sources.release.digest !== options.expectedReleaseDigest) {
    return { valid: false, status: "stale_release", reason: "The policy names a different release digest.", remediation: "Load or compile the policy approved for the intended release." };
  }
  return { valid: true, status: "valid" };
}
