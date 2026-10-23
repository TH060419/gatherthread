// Synthetic Claude transport only. This fixture never calls a provider.
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2), nativeSessionId = args[args.indexOf("--session-id") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ prompt, nativeSessionId,
  hasGatherThreadCredential: Object.keys(process.env).some(name => name.toUpperCase().startsWith("GATHERTHREAD_")) }));
const send = value => process.stdout.write(JSON.stringify({ ...value, session_id: nativeSessionId }) + "\n");
send({ type: "system", subtype: "init", model: "claude-sonnet-fixture" });
send({ type: "stream_event", event: { type: "content_block_delta", index: 0,
  delta: { type: "text_delta", text: "The reviewed migration ordering is preserved." } } });
send({ type: "assistant", message: { model: "claude-sonnet-fixture", content: [
  { type: "thinking", thinking: "HIDDEN_NATIVE_THINKING" },
  { type: "tool_use", id: "private-plan-id", name: "TodoWrite", input: { todos: [{ content: "Read the shared constraint", status: "completed" }] } },
] } });
send({ type: "assistant", message: { model: "claude-sonnet-fixture",
  content: [{ type: "text", text: "The reviewed migration ordering is preserved." }] } });
send({ type: "result", subtype: "success", is_error: false, result: "The reviewed migration ordering is preserved." });
