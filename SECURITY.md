# Security policy

InvokeSmith handles action contracts, policy decisions, and evidence that may influence production releases. Please report suspected vulnerabilities privately.

## Reporting

Do not open a public issue for a suspected vulnerability. Use the repository's **Security → Advisories → Report a vulnerability** flow with:

- the affected package, command, or artifact type;
- a minimal reproduction;
- the expected and observed security boundary;
- whether secrets, private state, signatures, tenant isolation, confirmation, idempotency, or release decisions are affected.

We will acknowledge a report within three business days and provide an initial severity assessment within seven business days. These targets are goals for the developer preview, not a contractual SLA.

## Scope priorities

We especially value reports involving cross-tenant access, signature verification bypasses, evidence tampering, path traversal, command execution, unsafe generated code, confirmation bypass, replay/idempotency failures, secret disclosure, or fail-open enforcement.

Never include live credentials or customer data in a report. Use synthetic SmithTasks fixtures whenever possible.

Only the latest commit on the default branch is currently supported during the developer preview.
