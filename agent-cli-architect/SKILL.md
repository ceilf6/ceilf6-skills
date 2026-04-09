---
name: agent-cli-architect
description: Design, audit, and refactor the outer CLI entry layer for AI agent tools. Use when a request involves multi-mode CLI design, command dispatch, startup flags, interactive versus headless routing, SSH or remote entry flows, slash-command versus subcommand separation, plugin or skill command registration, command discovery, or cold-start optimization. Not for runtime state-tier design or terminal frame rendering.
---

# Agent CLI Architect

Own the outside of the product: how users and systems enter the tool, how commands are routed, and how startup work is shared before the runtime UI is even alive.

## When To Use

- Adding or reviewing interactive, headless, SDK, SSH, deep-link, or remote entry paths.
- Consolidating duplicated initialization such as logging, migrations, config loading, or environment setup.
- Designing command registration for subcommands, slash commands, plugins, skills, or MCP integrations.
- Auditing slow startup, oversized main entry files, or handlers imported too early.

## Use Another Skill Instead

- Use `agent-state-architect` when the real problem is runtime state ownership, re-render propagation, or React and non-React state sharing.
- Use `tui-render-optimizer` when the runtime already launches correctly and the real problem is commit, layout, diff, or terminal I/O cost.
- Use both only if the request truly spans startup entry plus runtime behavior.

## Read First

- Read [references/entry-convergence.md](./references/entry-convergence.md) when the problem is entry flow, startup reuse, or cold-start.
- Read [references/command-registry.md](./references/command-registry.md) when the problem is command discovery, priority, deduplication, or plugin extensibility.

## Workflow

### 1. Map Entry Paths

List every invocation path and note:

- how it enters
- which initialization it needs
- where it diverges
- whether it should end in REPL, headless output, or a one-shot handler

Collect evidence from:

- the bootstrap entry file
- the main command tree
- early argv rewriting or pending-state handling
- dynamic imports, handler modules, and launch helpers

### 2. Find Duplicated Startup Work

Look for repeated init chains, eager imports for cheap flags, and mode-specific startup forks. Treat these as convergence candidates before adding new features.

### 3. Separate Command Planes

Keep shell subcommands and in-REPL slash commands as different planes with different lifecycle assumptions:

- CLI subcommands route and exit.
- Slash commands run inside an active session and touch live app state.
- Registration stays thin; execution lives in handlers or REPL command modules.

### 4. Converge To One Startup Skeleton

Push shared setup into one bootstrap layer or lifecycle hook. Carry mode-specific data through pending state, argv rewrites, or config overrides instead of creating a new startup branch.

### 5. Validate Extension Cost

Check that:

- `--help` and `--version` stay cheap
- adding one new mode mostly changes config, not boot code
- new subcommands inherit shared initialization automatically
- plugin and skill commands load lazily and dedupe predictably
- CLI-facing and REPL-facing command systems can evolve independently

## Output Shape

When using this skill, prefer producing:

- an entry inventory with convergence opportunities
- a target startup skeleton
- a split between external subcommands and internal slash commands
- a list of shared initialization concerns and where they should live
- a refactor sequence ordered by risk and payoff

## Guardrails

- Do not duplicate initialization across entry modes.
- Do not load heavy modules before cheap flag checks.
- Do not mix command registration with command execution logic.
- Do not merge subcommands and slash commands into one lifecycle.
- Do not eagerly load plugin, MCP, or skill commands at startup.
- Do not let runtime rendering or store concerns leak into CLI architecture decisions unless they change the entry contract.

## Decision Rules

- If several entry modes share most setup, converge them before adding another mode.
- If cold-start is slow for simple flags, add a bootstrap fast-path first.
- If the main CLI file is growing into a router plus business layer, extract handlers before extending it.
- If extensibility matters, define source priority and deduplication rules before shipping third-party commands.
- If the user's complaint starts after REPL launch rather than before it, hand off to `agent-state-architect` or `tui-render-optimizer` instead of stretching this skill past its layer.
