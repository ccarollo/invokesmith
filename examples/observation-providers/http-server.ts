import { JsonFileObservationProvider, type HttpObservationRequest } from "../../packages/observations/src/index.js";

const stateFile = process.argv[2];
if (!stateFile) throw new Error("Usage: bun run examples/observation-providers/http-server.ts <smithtasks-state.json>");
const delegate = new JsonFileObservationProvider(stateFile);

const server = Bun.serve({
  port: Number(process.env.INVOKESMITH_OBSERVER_PORT ?? 32109),
  async fetch(request) {
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    const { provider: _provider, ...observation } = await request.json() as HttpObservationRequest;
    const response = await delegate.observe(observation);
    return Response.json({ ...response, provider: { id: "example.smithtasks-http", version: "1.0.0" } });
  }
});

process.stdout.write(`SmithTasks observation provider listening on http://127.0.0.1:${server.port}\n`);
