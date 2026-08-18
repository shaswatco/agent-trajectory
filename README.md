# agent trajectory

Watch what your AI coding agents are actually doing — in the terminal, live.

One command shows every tool call, model response, token and context gauge across **Claude Code**, **Codex**, **DeepSeek Harness** and **Hermes**, merged into a single time-ordered feed.

```
agent trajectory · claude 278 · codex 2 · dsh 11 · hermes 186   q quit · s sessions · u unified
turns 69 · steps 550 · LLM 31.2s · TTFT 4.8s · 13.3 tok/s · cache 33% · in 77.1K · out 402
ctx ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 8% · 38.9K/498.1K

#1   claude ⚙ Bash         command=npm run build
#2   claude ✎ assistant    Build passed. Wiring the adapter next…
#3   codex  › user         add a retry around the fetch
#4   codex  ⚙ exec         cargo test --all
#5   dsh    ⚙ read         file_path=packages/llm/config.ts limit=1              0.2s
#6   dsh    ✖ turn         RATE_LIMIT: 429 free tier exceeded
```

## Install

```bash
npm install -g github:shaswatco/agent-trajectory
```

Then, from anywhere:

```bash
atrajectory
```

No configuration, no API keys, no setup. It finds your agents' session stores automatically and starts showing them.

Try it without installing:

```bash
npx github:shaswatco/agent-trajectory
```

> Not on the npm registry yet, so install from GitHub for now. Once published,
> `npm install -g agent-trajectory` will work the same way.

## What it shows

**Metrics strip** — turns, steps, model wall time, time-to-first-token, decode throughput, cache hit rate, and token totals.

**Context gauge** — how full the context window is, green under 70%, yellow past that, red past 90%.

**Activity feed** — one line per event, newest at the bottom:

| | Meaning |
|---|---|
| `›` | a prompt you typed |
| `⋯` | injected context — instruction files, system prompts, tool results |
| `✎` | model response |
| `⚙` | tool call, with an argument preview and duration |
| `✖` | a failure — tool error, or a turn that ended aborted or errored |

**Session picker** — press `s` for the ten most recent sessions across every agent; press a digit to focus one, `u` to return to the unified feed.

## Usage

```bash
atrajectory                      # everything, newest first
atrajectory --cwd                # only sessions from this directory
atrajectory --agent claude       # one agent
atrajectory --agent claude,codex # several
atrajectory --merge 3            # fewer sessions in the merged feed
atrajectory --interval 500       # poll faster
atrajectory --session <path>     # pin one session log
```

`--cwd` is the one to reach for when you want *this project* rather than everything on the machine.

### Keys

`q` quit · `s` session picker · `u` unified view · `0`–`9` select a session

## Coverage

Agents log different things. A figure an agent does not record shows as `—`, never as a fabricated `0`.

| | Feed | Turns / steps | Tokens & cache | Timing | Context window |
|---|:---:|:---:|:---:|:---:|:---:|
| **DeepSeek Harness** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Codex** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Claude Code** | ✓ | ✓ | ✓ | — | — |
| **Hermes** | ✓ | ✓ | — | — | — |

Claude Code transcripts carry per-message token usage but no step timing, so throughput and TTFT are unavailable. Hermes records neither, so it contributes rows and counts only.

## Where it reads

| Agent | Location | Override |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<uuid>.jsonl` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/{sessions,archived_sessions}/rollout-*.jsonl` | `CODEX_HOME` |
| DeepSeek Harness | `~/.dsh/sessions/<workspace>/session-*/session.jsonl.zstd` | `DSH_HOME` |
| Hermes | `~/.hermes/sessions/session_*.json` | `HERMES_HOME` |

Missing agents are skipped silently — install one, or four, and it adapts.

## Read-only, always

Session logs are opened for reading and nothing else. Nothing is written, locked, moved or deleted, so running this beside a live agent cannot disturb it. Compressed DeepSeek logs are decoded frame by frame, and a partially written trailing frame is skipped until the writer finishes it rather than treated as corruption.

Nothing leaves your machine. There is no telemetry, no network access, and no configuration file.

## Requirements

Node 22.15 or newer, for native Zstandard support in `node:zlib`. The only runtime dependencies are `ink` and `react`.

## Development

```bash
npm install
npm run build
node dist/cli.js
```

Adding an agent means one file in `src/adapters/` implementing `discover()` and `read()`, plus an entry in `src/registry.ts`. Adapters normalize into the shared `Row` and `Metrics` model in `src/types.ts` and report `undefined` for anything their format does not record.

## Prior art

Inspired by [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor), which does this beautifully for Claude Code's token quota. This one trades quota prediction for breadth: what the agent *did*, across whichever agents you run.

## License

MIT
