# Extensible Command Registry Patterns

Use this reference when designing a command system that supports multiple sources (builtins, plugins, skills, MCP, workflows) with proper deduplication and lifecycle separation.

## Dual Command Plane

Separate external CLI subcommands from internal REPL slash commands.

```
CLI Subcommand Plane (External)
─────────────────────────────────
Registration: Commander program.command('mcp').action(...)
Invocation:   Shell — `claude mcp list`
Execution:    Delegates to cli/handlers/* modules
Lifecycle:    Runs before TUI starts, exits after completion

Internal Slash Command Plane
─────────────────────────────────
Registration: getCommands() merges builtins + plugins + skills
Invocation:   REPL input — `/theme dark`
Execution:    Modifies AppState directly, returns JSX
Lifecycle:    Available during REPL session
```

Why separate:

- CLI subcommands have no REPL context (no AppState, no React tree).
- Slash commands need direct access to the running application state.
- Mixing them creates lifecycle confusion and import dependency tangles.

## Multi-Source Merge With Deduplication

Load commands from multiple sources in priority order:

```typescript
const loadAllCommands = memoize(async (cwd: string) => {
  const [skills, plugins, workflows] = await Promise.all([
    loadSkills(cwd),
    loadPlugins(cwd),
    loadWorkflows(cwd),
  ])

  return [
    ...bundledCommands,           // 1. Packaged base commands
    ...builtinPluginCommands,     // 2. Built-in plugins
    ...skills,                    // 3. Skills
    ...workflows,                 // 4. Workflows
    ...pluginCommands,            // 5. Third-party plugins
    ...pluginSkills,              // 6. Plugin skills
    ...COMMANDS(),                // 7. Core builtins (highest priority)
  ]
})
```

Then filter and deduplicate:

```typescript
async function getCommands(cwd) {
  const all = await loadAllCommands(cwd)
  return all
    .filter(cmd => meetsAvailabilityRequirement(cmd))  // auth/provider gates
    .filter(cmd => isCommandEnabled(cmd))              // feature flag gates
    .filter((cmd, i, arr) =>                           // deduplicate by name
      arr.findIndex(c => c.name === cmd.name) === i
    )
}
```

Source: `src/commands.ts:450-518`

## Per-CWD Memoized Loading

Commands depend on the working directory (local config, project plugins). Cache by cwd:

```
loadAllCommands = memoize(async (cwd) => { ... })
```

File watchers invalidate the cache on config changes:

```
.claude/settings.json changes → clearPluginCache() → reload on next getCommands()
skills/ directory changes → skillChangeDetector.emit() → rescan
```

## Feature Gate + Dead Code Elimination

```typescript
const briefCommand = feature('KAIROS')
  ? require('./commands/brief.js').default
  : null
```

`feature()` is replaced at build time. The bundler's DCE removes the dead branch entirely — no runtime cost, no bundle size impact.

## Slash Command Execution Flow

```
User types: /theme dark
    ↓
REPL parses: commandName = "theme", args = ["dark"]
    ↓
getCommands(cwd) → find matching command object
    ↓
command.call(args, context)
    ↓
  context.setAppState(s => ({ ...s, theme: 'dark' }))
  return <Text>Theme set to dark</Text>
    ↓
Render returned JSX in REPL
```

## Anti-Patterns

- Embedding execution logic in the registration file (splits routing from logic).
- Merging commands from multiple sources without deduplication (name collisions).
- Eagerly loading all plugin and MCP commands at startup (slow cold-start).
- Hardcoding feature checks instead of using build-time `feature()` flags (no DCE).
- Using a single command plane for both CLI subcommands and REPL slash commands (lifecycle mismatch).
