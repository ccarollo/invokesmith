import type { IntermediateAction } from "../../compiler/src/index.js";

export const TARGET_PLUGIN_API_VERSION = "invokesmith.target-plugin/v1" as const;

export type SupportLevel = "portable" | "emulated" | "unrepresentable" | "informational";
export type FindingSeverity = "info" | "warning" | "error";

export interface TargetFinding {
  code: string;
  actionId?: string;
  feature: string;
  support: SupportLevel;
  severity: FindingSeverity;
  message: string;
  mitigation?: string;
}

export interface GeneratedFile {
  path: string;
  contents: string;
  ownership: "managed" | "custom";
  executable?: boolean;
}

export interface GenerationPlan {
  apiVersion: typeof TARGET_PLUGIN_API_VERSION;
  target: string;
  pluginVersion: string;
  contractDigests: Record<string, string>;
  files: GeneratedFile[];
  findings: TargetFinding[];
}

export interface TargetPluginDescriptor {
  apiVersion: typeof TARGET_PLUGIN_API_VERSION;
  name: string;
  displayName: string;
  version: string;
  protocolVersion: string;
}

export interface TargetPlugin {
  describe(): TargetPluginDescriptor;
  analyze(actions: IntermediateAction[]): TargetFinding[];
  generate(actions: IntermediateAction[]): GenerationPlan;
}

export function assertGenerationPlan(plan: GenerationPlan): void {
  if (plan.apiVersion !== TARGET_PLUGIN_API_VERSION) throw new Error(`Unsupported target-plugin API ${plan.apiVersion}`);
  const paths = new Set<string>();
  for (const file of plan.files) {
    if (file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Generated path escapes the output directory: ${file.path}`);
    }
    if (paths.has(file.path)) throw new Error(`Target generated duplicate path: ${file.path}`);
    paths.add(file.path);
  }
  const blocking = plan.findings.filter((finding) => finding.severity === "error" || finding.support === "unrepresentable");
  if (blocking.length > 0) throw new Error(`Target generation blocked: ${blocking.map((finding) => finding.code).join(", ")}`);
}
