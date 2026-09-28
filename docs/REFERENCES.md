# Related projects and attribution

This project studies public repositories and open-source work. Unless a future file explicitly says otherwise, the initial implementation is original and no source code has been copied. A public repository without a detected license is reference material only and must not be copied or adapted.

| Project | What we study | License |
|---|---|---|
| [SyncVibe](https://github.com/Curious1008/syncvibe) | Cross-machine local-agent triggering, MCP chat tools, incremental chat reads | MIT |
| [multiplayer-ai](https://github.com/godfaddaai/multiplayer-ai) | Viewer/participant session sharing and participant provenance | MIT |
| [Agent Session Protocol](https://github.com/kevin-dp/agent-session-protocol) | Append-only normalized session events, live tail, import/resume | Apache-2.0 |
| [OpenClaw](https://github.com/openclaw/openclaw) | Session visibility modes, group context, model-labelled replies | MIT |
| [Buzz](https://github.com/block/buzz) | Durable signed event log and realtime human-agent rooms | Apache-2.0 |
| [Patchwork](https://github.com/vincelwt/patchwork) | Persistent relay, local runtimes, realtime multiplayer workspace | Apache-2.0 |
| [CHAP](https://github.com/BrightbeamAI/chap) | Human-agent identity, policy, audit, approvals and handoffs | Apache-2.0 code / CC-BY-4.0 specification |
| [acp-memory-server](https://github.com/SrulyRosenblat/agent_memory_mcp) | Cross-harness local transcript discovery and parsing | NOASSERTION (no license file detected; reference only, no code copied) |
| [harness-exchange](https://github.com/cnmoro/harness-exchange) | Codex/Claude/OpenCode transcript normalization boundaries | MIT |
| [OpenAI Codex](https://github.com/openai/codex) | Official App Server thread/turn lifecycle, `codex exec --json` migration behavior, and local sandbox controls used through the installed CLI; no source copied | Apache-2.0 |
| [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.2-rc.1) | Official npm profile/plugin/Client mechanism at `0.1.2-rc.1`, plus Host Agent/Session/persistence recovery at source commit [`d347e703`](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215) (`dsh-v0.1.3-alpha.1`); compatibility calls are original and isolated, no source copied | MIT |
| [micromark](https://github.com/micromark/micromark) | CommonMark parsing with raw HTML and dangerous URL protocols disabled for Web Agent output | MIT |
| [micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm) | GFM tables, task lists, autolinks, and strikethrough for Web Agent output | MIT |
| [KaTeX](https://github.com/KaTeX/KaTeX) | Bundled, accessible inline and display math rendering for Web Agent Markdown | MIT |
| [Driver.js](https://github.com/nilbuild/driver.js) | Published `driver.js@1.8.0` dependency for existing-control highlights and guide cards; application copy, arrows, visibility checks, dialog/focus integration and progress storage are original | MIT |

For beginner guides, [Driver.js configuration](https://driverjs.com/docs/configuration) supports vanilla JavaScript, target callbacks, lifecycle hooks and custom popovers without runtime dependencies. It was selected over [Shepherd](https://github.com/shipshapecode/shepherd) and [Intro.js](https://introjs.com/), whose current AGPL/commercial licensing adds obligations unnecessary for this client. The dependency is pinned rather than loaded from a CDN, and its published license is copied verbatim to `apps/web/dist/app/licenses/driver.js.txt`. No upstream source is copied into application source files.

Any later adaptation must record the exact upstream path, commit, applicable license, and modifications in this document and in the adapted source file.
