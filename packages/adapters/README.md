# Transcript adapters

This package normalizes the visible parts of local harness JSONL files into `user`, `assistant`, `tool_call`, and `tool_result` events. Codex rollout `response_item` records and Claude Code project message records are supported. Reasoning, thinking, system/developer messages, metadata records, and Claude sidechains are excluded.

All adapter output is labelled `harness_transcript`. These parsers do not observe an LLM provider request and never emit `provider_request` fidelity.

Reading is opt-in. Callers must supply one or more authorized roots. Paths are resolved through `realpath`, including symlinks, and files outside those roots are rejected. The JSONL tailer persists a byte offset plus file identity, advances only through complete lines, resets after truncation/rotation, and reports malformed complete lines without uploading them.

The redactor covers common bearer tokens, API keys, private keys, credentials, and recursively sensitive structured fields. Callers can add project-specific patterns. Redaction is defense in depth, not proof that arbitrary secrets cannot appear.
