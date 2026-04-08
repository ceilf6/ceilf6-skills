---
name: agent-cli-architect
description: Design and review CLI entry architectures for AI agent tools that support multiple invocation modes (interactive REPL, headless pipe, remote SSH, API SDK). Use when building a new agent CLI, adding a new entry mode to an existing CLI, auditing startup performance, consolidating duplicated initialization code, or designing an extensible command registry with plugin and skill support.
triggers:
  keywords:
    - "CLI architecture"
    - "command dispatch"
    - "multi-mode CLI"
    - "agent CLI"
    - "entry convergence"
    - "command registry"
    - "slash commands"
    - "plugin commands"
    - "CLI startup"
---

# Agent CLI Architect

Design CLI entry architectures that maximize infrastructure reuse across multiple invocation modes while keeping cold-start fast and the command surface extensible.

## Overview

A typical AI agent CLI must support at least three entry patterns: interactive TUI, headless pipe output, and programmatic SDK access. Without deliberate convergence these paths become separate codebases with duplicated initialization. This skill provides a workflow for auditing an existing CLI or designing a new one using patterns derived from Claude Code's architecture.

Read [references/entry-convergence.md](./references/entry-convergence.md) for the four convergence patterns and code-level examples.
Read [references/command-registry.md](./references/command-registry.md) for the dual command plane and multi-source merge patterns.

## Workflow

### 1. Inventory Entry Points

List every way users or systems invoke the CLI:

- Shell commands with arguments
- Piped input and non-interactive flags
- Deep links or URL schemes
- Remote connections (SSH, WebSocket)
- Daemon or background workers
- SDK and API access
- Subcommands (auth, plugin, config)

For each entry point, note which initialization steps it requires and which it skips.

### 2. Identify Convergence Opportunities

Check whether the codebase exhibits these duplication symptoms:

- Two or more entry paths that call the same initialization functions independently.
- A startup routine that loads heavy modules before checking simple flags like `--version`.
- Mode-specific code that could share a common startup skeleton with config overrides.
- Subcommands that re-implement logging, config loading, or migration logic.

Use the entry convergence patterns in the reference file to propose consolidation.

### 3. Design The Startup Skeleton

Establish a layered startup flow:

1. **Bootstrap fast-path**: Handle zero-import flags (`--version`, `--help`) before loading the full CLI.
2. **Lifecycle hooks**: Centralize shared initialization (`init()`, logging sinks, migrations, remote settings) in a single `preAction` hook that all commands inherit.
3. **Pending state carriers**: Parse special inputs early, store results in module-level pending variables, then fall through to the default command flow.
4. **Unified launch point**: All interactive modes converge to a single launch function with mode-specific differences expressed as config overrides, not separate startup chains.

### 4. Design The Command Registry

Decide on the command architecture:

- **CLI subcommands** (external): Registered via the command framework, executed before TUI starts, delegate to handler modules.
- **Internal slash commands** (REPL): Registered via a unified `getCommands()` function, executed inside the REPL, modify application state directly.
- **Multi-source merge**: Commands from builtins, plugins, skills, MCP servers, and workflows merged with deduplication and priority ordering.
- **Lazy loading**: Handler modules loaded via dynamic `import()` on demand, not at startup.

### 5. Validate Cold-Start And Reuse

Run these checks:

- `--version` and `--help` complete without loading the full CLI module tree.
- Adding a new subcommand inherits all shared initialization without extra code.
- Adding a new interactive mode only requires a config override to the existing launch point.
- Plugin and skill commands are discovered lazily and cached per working directory.
- No initialization logic is duplicated across entry paths.

## Output Shape

When using this skill, prefer producing:

- An entry point inventory with initialization dependency matrix.
- A startup skeleton diagram showing the layered flow.
- A command registry design with source priority and deduplication rules.
- Specific refactoring steps ordered by risk and impact.

## Guardrails

- Do not embed command execution logic in the registration file. Delegate to handler modules.
- Do not eagerly import heavy modules for simple flag checks.
- Do not duplicate initialization logic across commands. Use lifecycle hooks.
- Do not mix CLI subcommand registration with internal slash command logic.
- Do not load all plugin and MCP commands at startup. Use memoized lazy loading.
- Do not create separate UI startup chains for each mode. Converge to one launch point with config overrides.

## Decision Rules

- If the CLI has more than two entry modes that duplicate initialization, consolidate with a preAction lifecycle hook first.
- If cold-start exceeds 200ms for `--version`, add a bootstrap fast-path layer.
- If the command surface needs plugin extensibility, design a dual command plane before adding the first plugin.
- If subcommand handlers are growing large in the main file, extract them to `cli/handlers/*` modules.
