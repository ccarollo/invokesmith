export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  path: string;
  message: string;
  help?: string;
}

export interface ValidationResult<T> {
  value?: T;
  diagnostics: Diagnostic[];
  valid: boolean;
}

export function diagnostic(
  code: string,
  severity: DiagnosticSeverity,
  path: string,
  message: string,
  help?: string
): Diagnostic {
  return help === undefined ? { code, severity, path, message } : { code, severity, path, message, help };
}
