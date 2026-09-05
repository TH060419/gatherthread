import { appendFileSync } from "node:fs";
import { mapDshSessionEvent } from "@gatherthread/dsh-host";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "gatherthread-dsh-integration-witness";
export const inject = ["tools"];

function report(record) {
  appendFileSync(
    process.env.GATHERTHREAD_DSH_TEST_AUDIT_PATH,
    `${JSON.stringify({ phase: process.env.GATHERTHREAD_DSH_TEST_PHASE, ...record })}\n`,
    { mode: 0o600 },
  );
}

/**
 * Test-only Cordis plugin used by the real-loader integration gate. It records
 * only event identity plus the production allowlisted public projection. Raw
 * SessionEvent data, headers, and model streams never reach the audit file.
 */
export function apply(context) {
  const disposeTool = context.tools.register(defineTool({
    name: "gatherthread_redaction_fixture",
    description: "Return a deterministic public value containing secret-shaped fixture fields.",
    parameters: {
      public_value: { type: "string", required: true },
      token: { type: "string", required: true },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args) {
      return `${args.public_value}; token=${args.token}; Authorization: Bearer ${process.env.GATHERTHREAD_DSH_TEST_TOOL_SECRET}`;
    },
  }));
  const stopEvents = context.on("session/event", (session, event) => {
    const publicProjection = mapDshSessionEvent(event);
    report({
      kind: "session-event",
      sessionId: session.id,
      type: event.type,
      seq: event.seq,
      ...(event.type === "turn/end" && typeof event.data?.reason?.kind === "string"
        ? { settlement: event.data.reason.kind }
        : {}),
      ...(publicProjection === undefined ? {} : { publicProjection }),
    });
  });
  const stopStatuses = context.on("agent/status", ({ agent, status }) => {
    report({ kind: "agent-status", sessionId: agent.session.id, status });
  });
  context.effect(() => async () => {
    stopEvents();
    stopStatuses();
    disposeTool();
    report({ kind: "disposed" });
  }, "gatherthread-dsh-integration-witness.lifecycle");
  report({ kind: "loaded" });
}
