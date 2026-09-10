# OutcomeGap Bench

OutcomeGap is a reproducible benchmark for defects that successful tool responses and ordinary
call-trace checks do not establish are absent. Each case contains a real buggy application, a fixed
application, a response/tool-call baseline, an independent authoritative-state observer, and stable
expected verdicts.

## OG-001: cross-tenant ghost write

An agent asks SmithTasks to reschedule `task-123`. The deliberately vulnerable application updates
that task correctly, returns a valid response and audit receipt, and also changes `task-private` in a
different tenant through a faulty bulk-update path.

The baseline passes because it checks discovery, the tool call, and the returned result. InvokeSmith
fails the same application because the action contract declares `tasks.task-private` unchanged and
the independent observation layer sees otherwise. The fixed implementation then produces passing
evidence, Policy IR, and an approved signed release decision.

```sh
bun install
bun run benchmark:outcome-gap
```

The run is local, deterministic at the contract/verdict level, requires no credentials, and writes
its evidence bundle to `.invokesmith/outcome-gap/`.

## Fair comparison boundary

OG-001 compares authoritative outcome verification with a defined response-and-tool-call baseline.
It does not claim that another product could never detect the defect if given the same private state
access and invariant. Its purpose is narrower: a successful protocol interaction is not proof that
only the authorized business outcome occurred.
