# SmithTasks reference application

SmithTasks is InvokeSmith's executable reference application. It is intentionally small, but its three actions exercise the safety semantics that a real integration must preserve:

- search is read-only and filters data by the acting user;
- reschedule is a reversible write with durable idempotency and an audit receipt;
- delete is destructive, requires MCP confirmation, remains recoverable for 30 days, and produces a durable audit receipt.

## Run the demo server

From the `technology` directory:

```sh
bun run start:demo
```

The demo identity is `user-123` in `tenant-demo`, with the three scopes required by the reference
actions. State is persisted to `.invokesmith/smithtasks-demo.json`. Omitting the identity, tenant, or a
required scope causes the application service to reject the action. Tenant and owner checks remain in
the SmithTasks service even after a InvokeSmith policy permit.

The MCP client must support elicitation to execute the delete action. Discovery and read-only calls still work without it.

## Verify the outcome engine

```sh
bun run test:outcome-engine
```

The suite tests authorization failures, private-task isolation, state changes, confirmation enforcement, replay-safe writes, conflicting idempotency keys, persistent audit records, and the real generated stdio server.
