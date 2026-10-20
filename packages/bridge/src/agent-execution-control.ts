import { CollaborationHttpError } from "./http-client.js";

/** Exact authority revocation must stop work even when a native turn emits no progress. */
export function createAgentExecutionWatch(options: {
  read?: () => Promise<{ active: boolean }>;
  required: boolean;
  controller: AbortController;
}) {
  let pending: Promise<void> | undefined;
  let unsupported = false;
  let confirmed = false;
  let observedControl = false;
  const check = (): Promise<void> => {
    if (pending) return pending;
    if (options.controller.signal.aborted || unsupported) return Promise.resolve();
    const operation = (async () => {
      if (!options.read) {
        if (options.required) options.controller.abort(new CollaborationHttpError(409,
          "Update the connector to support native Team cancellation", "connector_update_required"));
        return;
      }
      try {
        const state = await options.read();
        observedControl = true;
        confirmed = state.active === true;
        if (!confirmed) options.controller.abort(agentExecutionCancelled());
      } catch (error) {
        if (error instanceof CollaborationHttpError && [400, 401, 403, 404, 409, 410, 422].includes(error.status)) {
          // Only an initial 404 can be an older server. Once observed, a
          // disappearing resource revokes authority but must retain exit ACKs
          // so the detached native capacity hold can be released after exit.
          if (error.status === 404 && !observedControl) unsupported = true;
          if (options.required || observedControl || error.status !== 404) options.controller.abort(agentExecutionCancelled());
        }
        // A transport outage is unknown authority, not proof of cancellation.
        // The server retains the native capacity hold until an actual stop ACK.
      }
    })();
    pending = operation;
    void operation.finally(() => { if (pending === operation) pending = undefined; });
    return operation;
  };
  const timer = setInterval(() => { void check(); }, 1_000);
  timer.unref();
  return {
    check,
    supported: () => options.read !== undefined && !unsupported,
    assertReady() {
      if (options.required && !confirmed && !options.controller.signal.aborted) options.controller.abort(new CollaborationHttpError(503,
        "Native execution authority could not be confirmed; reconnect before retrying the accepted request", "agent_execution_unconfirmed"));
      options.controller.signal.throwIfAborted();
    },
    async close() { clearInterval(timer); await pending; },
  };
}

export function agentExecutionCancelled(): CollaborationHttpError {
  return new CollaborationHttpError(409, "The Agent execution was stopped or its claim is no longer active", "agent_execution_cancelled");
}

export function isDefinitiveAgentExecutionRejection(error: unknown): boolean {
  return error instanceof CollaborationHttpError && [401, 403, 404, 409, 410].includes(error.status);
}
