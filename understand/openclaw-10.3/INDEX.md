# Understand Anything — openclaw v2026.10.3

| | |
|---|---|
| tag | `v2026.10.3` |
| commit | `59cb44796b0f1f0daa0e37af8b1495abb45d9bc1` |
| matches running gateway | yes (`59cb447`) |
| tracked files | 52,546 |
| raw features detected | 308, grouped into 33 chunks |
| internal feature edges | 1,982 |
| SDK-surface edges | 6,351 |
| status | **pass 1 and pass 2 complete — 33 of 33 documented** |

Every feature doc lives on its own branch, unmerged, pending review.
The full progress file with the machine-readable dependency graph is on the
mini at `fox-tools/understand/openclaw-10.3/` (`PROGRESS.md`, `raw/*.json`).

## The 33 features

| branch | feature | what it is |
|---|---|---|
| `understand/F01-config-and-schema` | config and schema | the file, the Zod schema, the write-safety envelope — and, misfiled, the session transcript store |
| `understand/F02-infra` | infra | not utilities: self-update, the outbound queue, exec allowlisting, SSRF-guarded fetch, approvals |
| `understand/F03-state-sessions-storage` | state, sessions, storage | two SQLite databases under an owner-and-lease discipline; git-backed snapshots |
| `understand/F04-logging-audit-trajectory` | logging, audit, trajectory | 145 KB of redaction with three audiences, and decision receipts that record the facts behind a decision |
| `understand/F05-secrets-and-security` | secrets and security | **a secret egress proxy that substitutes a sentinel at the wire** — built, unused |
| `understand/F06-gateway-protocol-and-client` | gateway protocol and client | 190 closed-object schemas: the real API surface, and the best entry point to the codebase |
| `understand/F07-gateway` | gateway | 4,253 files. The desktop subsystem, the voice relay, 454 RPC method modules |
| `understand/F08-agents` | agents | the harness, the sandbox, compaction, and a corpus-tested provider failure classifier |
| `understand/F09-auto-reply` | auto-reply | the orchestrator — and the whole slash-command surface, ~60 commands |
| `understand/F10-plugin-system` | plugin system | the 346-subpath SDK with a machine-checked API baseline; the computer-use contract |
| `understand/F11-channels-and-chat` | channels and chat | the adapter contract, streaming, and access decisions that carry evidence |
| `understand/F12-cli-and-commands` | CLI and commands | **a 173-file doctor that diagnoses *and repairs*** |
| `understand/F13-tui` | TUI, terminal-core, markdown-core | a markdown IR with render-aware chunking; a TUI that can run the agent itself |
| `understand/F14-daemon-process-worker` | daemon, process, worker, fleet | three service managers, a spawn broker, process group anchors, a cell registry |
| `understand/F15-node-host-and-pairing` | node host and pairing | key-based pairing, and a native Rust node host with its own sidecar protocol |
| `understand/F16-voice-talk-and-tts` | voice, talk, TTS | three separate provider contracts; the host injects the brain |
| `understand/F17-media-understanding-and-generation` | media | five files per modality, and four openai-compatible shortcuts |
| `understand/F18-skills-claws-flows` | skills, claws, flows | a skill security scanner, and 13 provenance modules on installed capabilities |
| `understand/F19-cron-and-system-agent` | cron and system agent | a scheduled job is an isolated agent run; model output becomes a typed operation before anything changes |
| `understand/F20-model-routing-and-llm` | model routing and LLM | the transports are `packages/ai` (193 files), not `src/llm` (29) |
| `understand/F21-mcp-and-acp` | MCP and ACP | ACP is twelve times the size of MCP; both are also conversational channels |
| `understand/F22-memory-and-context` | memory and context | four engines behind a registry that can quarantine one; a sleep-inspired consolidation model |
| `understand/F23-boards-projects-workboard` | boards and work tracking | the worked example of a plugin shipping its own web UI |
| `understand/F24-canvas-browser-computer-use` | canvas, browser, computer use | **`cua-computer` is a shipped computer-use provider**; two browser routes; a capture proxy |
| `understand/F25-control-panel-ui` | the Control UI | 41 pages, 18 locales, a terminal and a VNC viewer — and a written state-ownership doctrine |
| `understand/F26-model-provider-extensions` | model providers | the reference realtime voice and transcription factories, and a delegation controller |
| `understand/F27-messaging-channel-extensions` | messaging channels | 988k LOC with no relative imports into the core: the abstraction holds completely |
| `understand/F28-meetings-and-realtime-rooms` | meetings | five small modules per platform; FaceTime driven through a native helper |
| `understand/F29-coding-agent-extensions` | coding agents | hosting a foreign agent costs about eight bridges |
| `understand/F30-qa-diagnostics-policy` | QA, policy, diagnostics | a mock provider server, live destructive scenarios, and policy as doctor checks |
| `understand/F31-native-apps` | native apps | **Talk Mode already exists on iOS and Android**; the gap is a gateway-side provider |
| `understand/F32-docs-and-support` | docs and CI | 1,408 doc files, and a CI built on proof rather than passing |
| `understand/F33-unclaimed-remainder` | the remainder | the uncompiled bootloader, encrypted storage, the QuickJS sandbox |

## Pass 1 findings

1. **The repo is not a workspace at the root.** `pnpm-workspace.yaml` governs `extensions/*` and `packages/*`; `src/` is one flat TypeScript program.
2. **`src/` is the monolith** — 79 directories, 4.3 M LOC. `gateway` and `agents` are 40% of it and had to be sub-chunked.
3. **`extensions/` is 175 directories but thin** — ~120 are model providers under 25 k LOC each.
4. **The SDK surface is the architecture.** The whole of `extensions/` resolves to ~90 relative edges into `src/`, against 6,351 edges through `openclaw/plugin-sdk/*`.
5. **No barrel files anywhere.** A grep against a wrong filename guess returns a clean empty result indistinguishable from "the feature does not exist". Every absence claim in these docs was checked against `git ls-files`.
6. **Two directory names actively mislead**: `src/memory` is two files, and `src/llm` is a compatibility shim layer.
