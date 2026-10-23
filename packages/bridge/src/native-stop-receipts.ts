import type { CursorStore } from "./cursors.js";
import type { CollaborationApi, HarnessExecutor, NativeExecutionExitReceipt } from "./types.js";

type ExitApi = Pick<CollaborationApi, "acknowledgeAgentExecutionStopped">;
export type ExitEvidence = Pick<HarnessExecutor, "readStoppedExecutions" | "acknowledgeExecutionExit">;

/** Cleanup is independent of current session discovery and native registration. */
export async function recoverNativeExecutionReceipts(api: ExitApi, store: CursorStore, executor?: ExitEvidence): Promise<void> {
  const previous = (await store.load()).stoppedExecutions ?? [];
  // An already confirmed cursor receipt must not wait for an unrelated unknown
  // native owner/journal. Server ACK is required before changing local evidence.
  await flushNativeExecutionReceipts(api, store);
  if (api.acknowledgeAgentExecutionStopped) for (const receipt of previous) {
    try { await executor?.acknowledgeExecutionExit?.(receipt); }
    catch { /* An uncertain journal stays unchanged after the exact server ACK. */ }
  }
  if (api.acknowledgeAgentExecutionStopped && executor?.readStoppedExecutions) {
    const stopped = await executor.readStoppedExecutions();
    if (!Array.isArray(stopped) || stopped.length > 1000 || stopped.some(receipt => !receipt || typeof receipt !== "object"
      || Object.keys(receipt).length !== 4 || ![receipt.sessionId, receipt.requestId, receipt.runtimeId].every(id => typeof id === "string" && id.length > 0 && id.length <= 200)
      || !Number.isSafeInteger(receipt.claimAttempt) || receipt.claimAttempt < 1)) throw new Error("Invalid native execution stop receipts");
    const state = await store.load(), receipts = state.stoppedExecutions ?? [];
    for (const receipt of stopped) if (!receipts.some(item => sameReceipt(item, receipt))) receipts.push(receipt);
    if (receipts.length > 1000) throw new Error("Native execution stop receipt capacity exhausted");
    if (stopped.length > 0) await store.save({ ...state, stoppedExecutions: receipts });
  }
  await flushNativeExecutionReceipts(api, store, executor);
}

export async function flushNativeExecutionReceipts(api: ExitApi, store: CursorStore, executor?: ExitEvidence): Promise<void> {
  if (!api.acknowledgeAgentExecutionStopped) return;
  while (true) {
    const receipt = (await store.load()).stoppedExecutions?.[0];
    if (!receipt) return;
    await api.acknowledgeAgentExecutionStopped(receipt.sessionId, receipt.requestId, receipt.runtimeId, receipt.claimAttempt);
    await executor?.acknowledgeExecutionExit?.(receipt);
    // Never restore a cursor snapshot captured before a network wait.
    const latest = await store.load();
    await store.save({ ...latest, stoppedExecutions: latest.stoppedExecutions?.filter(item => !sameReceipt(item, receipt)) ?? [] });
  }
}

function sameReceipt(a: NativeExecutionExitReceipt, b: NativeExecutionExitReceipt) {
  return a.sessionId === b.sessionId && a.requestId === b.requestId && a.runtimeId === b.runtimeId && a.claimAttempt === b.claimAttempt;
}
