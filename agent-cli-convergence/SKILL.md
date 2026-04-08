---
name: agent-cli-convergence
description: >-
  Design CLI entry architecture with entry convergence, mode routing, and
  maximum code reuse. Derived from Claude Code's production patterns. Use when
  building a CLI that supports multiple entry modes (interactive, headless,
  remote, protocol URLs), when refactoring CLI entry points for better reuse,
  or when designing a Commander.js / yargs command tree with shared
  initialization and delegated handlers.
---

# CLI Entry Convergence and Mode Routing

Patterns for building complex CLIs that support many entry modes while maximizing code reuse. Derived from Claude Code (~4,700-line `main.tsx` supporting interactive, headless, remote, SSH, assistant, protocol URL, and MCP modes).

## Core Principle

Instead of each entry mode maintaining its own startup path, **converge all entries into the fewest possible execution paths** by rewriting inputs and stashing metadata early.

## Pattern 1: Argv Rewriting + Pending State

**Problem:** Multiple entry modes (protocol URLs, SSH, assistant) each need a full startup path, duplicating initialization.

**Solution:** Parse special inputs early, stash extracted metadata into pending state objects, rewrite `process.argv` to look like the default command, then let the single main flow handle everything.

```typescript
// Pending state carriers — typed, narrowly scoped
let _pendingConnect: {
  url?: string
  authToken?: string
  dangerouslySkipPermissions: boolean
} | undefined = { dangerouslySkipPermissions: false }

let _pendingSSH: {
  host?: string
  dir?: string
  local: boolean
  permissionMode: string | undefined
  dangerouslySkipPermissions: boolean
} | undefined = { ... }

// Early in main(), BEFORE Commander parses:
const rawArgs = process.argv.slice(2)
const ccIdx = rawArgs.findIndex(a => a.startsWith('cc://'))
if (ccIdx !== -1 && _pendingConnect) {
  const parsed = parseConnectUrl(rawArgs[ccIdx]!)
  _pendingConnect.url = parsed.serverUrl
  _pendingConnect.authToken = parsed.authToken
  // Strip the URL, rewrite argv to look like the default command
  const stripped = rawArgs.filter((_, i) => i !== ccIdx)
  process.argv = [process.argv[0]!, process.argv[1]!, ...stripped]
}
```

**Key insight:** The pending state objects act as a decoupled message channel between the early-parse phase and the later action phase. The main command handler checks these objects to decide which mode to enter, but the startup path is shared.

**Reuse achieved:**
- `cc://` interactive reuses the default interactive REPL path
- `cc://` + `-p` headless reuses the existing `open` subcommand
- `claude assistant [id]` reuses the main interactive path
- `claude ssh <host>` reuses the main interactive path

## Pattern 2: Two-Stage Bootstrap

**Problem:** Heavy imports (~135ms) penalize simple commands like `--version`.

**Solution:** Split into a thin entry (`cli.tsx`) with zero heavy imports for fast paths, then dynamic-import the full CLI (`main.tsx`) only when needed.

```typescript
// cli.tsx — bootstrap entry, minimal imports
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Fast path: zero module loading
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  // Other fast paths (MCP server, Chrome host, daemon) ...
  if (args[0] === '--mcp') {
    const { runMcpServer } = await import('./mcp/server.js')
    await runMcpServer()
    return
  }

  // Full path: dynamic import of heavy main
  const { main: cliMain } = await import('../main.js')
  await cliMain()
}
```

**Design rule:** Each fast path should import only what it needs. The full `main.tsx` with its 120+ imports is only loaded for interactive/headless sessions.

## Pattern 3: Lifecycle Hooks for Shared Initialization

**Problem:** Every subcommand needs the same setup (init, logging, migrations, config loading) but duplicating it in each `.action()` is fragile.

**Solution:** Use Commander's `preAction` hook to run shared initialization once.

```typescript
program.hook('preAction', async (thisCommand) => {
  // 1. Await parallel subprocess results started at module load
  await Promise.all([
    ensureMdmSettingsLoaded(),
    ensureKeychainPrefetchCompleted(),
  ])

  // 2. Core initialization (env, config, repo detection)
  await init()

  // 3. Attach logging sinks (idempotent)
  const { initSinks } = await import('./utils/sinks.js')
  initSinks()

  // 4. Run migrations
  await runMigrations()

  // 5. Load remote settings and policy limits
  await Promise.all([
    loadRemoteManagedSettings(),
    loadPolicyLimits(),
  ])

  // 6. Set entrypoint marker for telemetry
  initializeEntrypoint(thisCommand.name())
})
```

**Benefit:** Adding a new subcommand automatically gets all shared setup. No subcommand can accidentally skip migrations or logging init.

## Pattern 4: Unified Command Tree + Delegated Handlers

**Problem:** A large CLI with many subcommands (mcp add/remove/list, config, doctor, plugin install/uninstall, auth, review...) bloats the main entry file.

**Solution:** The main file owns the command tree structure; complex handler logic is delegated to external modules.

```typescript
// main.tsx — command tree skeleton
const mcp = program.command('mcp').description('Manage MCP servers')

// Delegate complex registration to external module
registerMcpAddCommand(mcp)

// Simple commands stay inline
mcp.command('remove <name>')
  .description('Remove an MCP server')
  .action(async (name, options) => {
    // Thin handler — delegates to imported handler
    const { handleMcpRemove } = await import('./cli/handlers/mcp.js')
    await handleMcpRemove(name, options)
  })

// External registration module
// src/commands/mcp/addCommand.ts
export function registerMcpAddCommand(parent: Command): void {
  parent.command('add <name> <config>')
    .description('Add an MCP server')
    .option('-s, --scope <scope>', 'Scope')
    .action(async (name, config, options) => { ... })
}
```

**Rules:**
- `main.tsx` is the **skeleton** (command tree + routing), not the **muscle** (business logic)
- Handler modules in `cli/handlers/` own the execution logic
- Registration fragments (like `registerMcpAddCommand`) can be imported from the command's own directory

## Pattern 5: Shared Startup Skeleton

**Problem:** Interactive mode, SSH mode, remote mode, and assistant mode all need similar startup sequences.

**Solution:** Define a shared startup contract that all interactive modes flow through.

```typescript
// The shared interactive startup chain:
// 1. createRoot()         — create Ink terminal root
// 2. showSetupScreens()   — onboarding, trust dialogs, auth
// 3. launchRepl()         — mount <App><REPL /></App>
// 4. renderAndRun()       — render + waitUntilExit

// Each mode builds its sessionConfig, then enters the same chain:
const sessionConfig = {
  ...baseConfig,
  // Mode-specific overrides only
  ...(isSSHMode && { remoteHost: _pendingSSH.host }),
  ...(isResumeMode && { resumeContext }),
  ...(isDirectConnect && { connectUrl: _pendingConnect.url }),
}

// All modes converge here:
const root = createRoot(renderOptions)
await showSetupScreens(root, ...)
await launchRepl(root, appProps, replProps, renderAndRun)
```

**The `launchRepl` function** uses dynamic imports to defer heavy component loading:

```typescript
async function launchRepl(root, appProps, replProps, renderAndRun) {
  const { App } = await import('./components/App.js')
  const { REPL } = await import('./screens/REPL.js')
  await renderAndRun(root, <App {...appProps}><REPL {...replProps} /></App>)
}
```

## Anti-Patterns to Avoid

1. **Separate startup chains per mode** — leads to divergent initialization, missed setup steps
2. **Flag-heavy action handlers** — instead of `if (isSSH) ... else if (isRemote) ...`, use pending state + shared config
3. **Inline handler logic in command tree** — makes `main.tsx` unreadable and untestable
4. **Synchronous heavy imports at entry** — penalizes fast-path commands with unnecessary load time

## Checklist for New Entry Modes

- [ ] Can the new mode reuse the default command path via argv rewriting?
- [ ] Is mode-specific metadata stashed in a typed pending state object?
- [ ] Does the mode flow through the shared `preAction` hook?
- [ ] Does it converge into `createRoot -> showSetupScreens -> launchRepl`?
- [ ] Are heavy imports deferred with dynamic `import()`?
