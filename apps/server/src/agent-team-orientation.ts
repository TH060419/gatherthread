import type { AgentTeamPlan } from "@gatherthread/protocol";

/** Public organization facts only. Runtime bindings and other module prompts stay out of this manifest. */
export function teamOrientation(plan: AgentTeamPlan, input: {
  entryNodeId: string; nodeId: string; callerNodeId: string | null; returnedFromNodeId: string | null;
  firstContact: boolean; phase: "initial_assignment" | "delegated_assignment" | "reviewing_return" | "clarification_resume";
  callsUsed: number; maxCalls: number; deadlineAt: string; remainingSeconds: number;
}) {
  const node = (id: string | null) => id === null ? { kind: "human_requester" as const }
    : { kind: "module" as const, id, name: plan.nodes.find(candidate => candidate.id === id)!.label };
  const allowed = plan.edges.flatMap(edge => edge.source === input.nodeId ? [edge.target]
    : edge.direction === "bidirectional" && edge.target === input.nodeId ? [edge.source] : []);
  return {
    first_contact: input.firstContact,
    overview_delivery: input.firstContact ? "first_module_call" : "refreshed_for_this_independent_call",
    team: { name: plan.name, entry_node_id: input.entryNodeId,
      modules: plan.nodes.map(candidate => ({ id: candidate.id, name: candidate.label, role: candidate.role || "Complete the assigned task." })),
      connections: plan.edges.map(edge => ({ source: edge.source, target: edge.target, direction: edge.direction })),
      connection_meaning: "Allowed calls, not a mandatory execution sequence. A child's result returns to its caller without a reverse edge." },
    current_module: node(input.nodeId), assigned_by: node(input.callerNodeId), return_result_to: node(input.callerNodeId),
    returned_result_from: input.returnedFromNodeId === null ? null : node(input.returnedFromNodeId),
    phase: input.phase, allowed_call_targets: allowed.map(node),
    limits: { max_calls: input.maxCalls, calls_already_accepted: input.callsUsed,
      calls_remaining_including_this_call: Math.max(0, input.maxCalls - input.callsUsed),
      deadline_at: input.deadlineAt, seconds_remaining: Math.max(0, input.remainingSeconds) },
  };
}
