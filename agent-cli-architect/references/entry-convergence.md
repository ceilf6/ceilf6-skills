# CLI Entry Convergence Patterns

Use this reference when designing or auditing multi-mode CLI entry architectures. Patterns are derived from Claude Code's `src/main.tsx`, `src/entrypoints/cli.tsx`, and supporting modules.

## Pattern 1: Bootstrap Fast-Path

Handle simple flags with zero heavy imports before loading the full CLI.

```
cli.tsx (bootstrap)
    ↓
  args = process.argv.slice(2)
    ↓
  --version? → console.log(VERSION); return     ← zero imports
  --dump-system-prompt? → load minimal → return
  --daemon-worker? → load worker → return
  remote-control? → load bridge → return
    ↓
  No match → load full CLI: await import('../main.js')
```

Key rules:

- Each fast-path only dynamically imports what it needs.
- Feature-gated fast-paths use build-time `feature()` flags for dead code elimination.
- Fast-paths return or exit after completion, never fall through accidentally.

## Pattern 2: PreAction Lifecycle Hook

Centralize shared initialization in a single hook that all commands inherit.

```typescript
program.hook('preAction', async thisCommand => {
  await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])
  await init()
  const { initSinks } = await import('./utils/sinks.js')
  initSinks()
  runMigrations()
  void loadRemoteManagedSettings()
  void loadPolicyLimits()
})
```

What this covers for every command:

- Async subprocess completion (MDM, keychain).
- Core initialization (config validation, env vars, shutdown hooks).
- Logging sink attachment.
- Plugin registration for `--plugin-dir`.
- Data migrations.
- Remote settings and policy limits (fire-and-forget).

Source: `src/main.tsx:905-967`

## Pattern 3: Pending State + Argv Rewrite

Parse special inputs early, store results, rewrite argv if needed, then continue through the default command flow.

```
Entry                     Pending Variable           Continues As
────────────────────────────────────────────────────────────────
cc:// URL (interactive)   _pendingConnect            default interactive
cc:// URL (headless)      argv rewritten to 'open'   headless flow
assistant [sessionId]     _pendingAssistantChat      default interactive
ssh host [dir]            _pendingSSH                default interactive
--update / --upgrade      argv rewritten to 'update' update subcommand
```

This reduces N entry modes to "default command + M config overrides" instead of N independent startup chains.

## Pattern 4: Unified Launch Skeleton

All interactive modes converge to the same three-step launch:

```
createRoot(renderOptions)       ← Mount Ink React root
    ↓
showSetupScreens(root, ...)     ← Trust dialog, onboarding, MCP approvals
    ↓
launchRepl(root, appProps,      ← Render App > REPL with mode-specific config
           replProps, renderAndRun)
```

Mode-specific differences are expressed as `replProps.sessionConfig` overrides:

- `continue` session: load existing conversation.
- `resume` session: show picker, load transcript.
- SSH remote: spawn auth proxy, create SSH session.
- Fresh session: start with empty state.

The `renderAndRun` helper is shared:

```typescript
export async function renderAndRun(root, element) {
  root.render(element)
  startDeferredPrefetches()       // background work after first render
  await root.waitUntilExit()      // block until REPL unmounts
  await gracefulShutdown(0)
}
```

Source: `src/replLauncher.tsx`, `src/interactiveHelpers.tsx`

## Pattern 5: Handler Delegation

Subcommands keep the main file thin by delegating to handler modules:

```
main.tsx (routing only)           cli/handlers/ (business logic)
─────────────────────────         ─────────────────────────────
program.command('mcp')
  .command('list')
    .action(() => {
      import('./cli/handlers/mcp.js')
        .then(m => m.handleMcpList())
    })
```

Benefits:

- Main file stays small and readable.
- Handlers are independently testable.
- Dynamic import ensures only used handlers are loaded.

Source: `src/cli/handlers/`

## Pattern 6: Unified setup() Function

A single `setup()` function serves both interactive and headless modes:

```typescript
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void>
```

Mode differences are expressed as boolean parameters. The function branches internally rather than requiring callers to assemble their own setup sequences.

Source: `src/setup.ts:56-66`

## Anti-Patterns

- Duplicating `init()` calls across multiple command actions instead of using a lifecycle hook.
- Loading the full module tree to check `--version`.
- Maintaining separate interactive startup chains for continue, resume, SSH, and fresh session modes.
- Embedding complex handler logic directly in the command registration file.
- Synchronously importing all handler modules at startup instead of using dynamic `import()`.
