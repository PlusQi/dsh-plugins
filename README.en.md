# dsh-plugins

[简体中文](./README.md) | English

Personal extension pack for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).
One repo = one profile bundle: all plugins live in a single pack — adding a plugin is just code + a restart, no reinstall.

## Plugins

| Plugin      | Function                                                                                          | Design spec                          |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **tokprev** | "Next-turn input preview" below the Composer (context + queued + draft, live as you type) + a real usage badge on each turn's closing message (provider-reported: input / cache / output / call count) | [SPEC-tokprev.md](./docs/specs/archive/SPEC-tokprev.md) |

## tokprev

A closed loop for per-turn token consumption: before you send, it tells you roughly how many tokens the next turn will feed in; after the turn ends, it reconciles with provider-reported actuals.

![tokprev in action](./docs/assets/tokprev.png)

Note: on-screen labels are currently Chinese-only; the examples below translate what they mean.

### Pre-send preview (below the Composer)

Example:

> **Next-turn input ≈ 36.2K (28%)** · context 33.8K + queued 0.1K + draft 0.3K · output estimate 1.5K–3K

- **Next-turn input** = context base (`contextPressure.projectedTokens`, provider-anchored) + queued messages + draft — updates live as you type;
- **Percentage** = next-turn input / context window;
- **Output estimate** = the [P25, P75] range of the last 5 turns' actual `outputTokens`; `-` with no history, `≈value` with exactly one turn;
- Fallback: with no provider anchor (fresh session) it falls back to a heuristic estimate (`contextBreakdown`, sum of three buckets) and prefixes the context figure with `*`; while the session is running the whole line hides (nothing to predict), and reappears when idle.

### Per-turn actual usage badge

A muted one-liner rendered on the closing assistant message of each turn (durable — survives page refresh and shows on history turns):

> `This turn: input 12.4K (3 calls · cache 11.8K) · output 2.1K`

- Data is the provider-reported truth, summed over all calls in the turn; billed input = `inputTokens + cacheReadTokens + cacheWriteTokens`;
- Hover for exact token counts and call count.

### A note on metrics (preview ≠ badge)

- The **preview** estimates the prompt size of a single request;
- The **badge** reports the **sum of billed input across all calls of the turn** — in a multi-step turn every step resends the full context, so the total is far larger than a single request; the cache-hit field (the "cache" segment in the badge) explains the gap. The two measure different things, both meaningfully.

### Host contracts

UI slots `conversation.composer.dock` and `conversation.chat.assistant-actions`; projection fields `contextPressure` / `contextBreakdown`; `AssistantMessageNode.usage`. Every read path degrades gracefully (renders null when data is missing, never throws).

## Installation (web profile)

Prerequisites: Node.js, git, pnpm (`npm i -g pnpm`). Private repos work too (pnpm uses your local git credentials).

```powershell
# Install from GitHub (other users)
npx @deepseek-ai/dsh plugin --profile web add github:PlusQi/dsh-plugins

# Pin a version: # accepts a tag / branch / commit
npx @deepseek-ai/dsh plugin --profile web add github:PlusQi/dsh-plugins#v0.2.0

# Local dev link (edit + restart to see changes)
npx @deepseek-ai/dsh plugin --profile web add link:D:\Workbench\garbage\JavaScript\dsh-plugins
```

After installing, **restart the dsh web process** and reload the page (profile composition only happens at startup).
Install location: `$DSH_HOME/profiles/web/` (default `~/.dsh`). `dsh plugin` is a pnpm forwarder:
after install it automatically attaches packages declaring `dsh.bundle` to the `dsh.profile.bundles` layer list — no manual config edits.
This pack has no build scripts, so git installs never trip pnpm's build-script gate (allowBuilds).
If published to npm, `npx @deepseek-ai/dsh plugin --profile web add dsh-plugins` works the same way.

## Update / uninstall / toggling a single plugin

```powershell
# Update: re-resolves the install spec (unpinned refs pull the default branch's latest commit)
npx @deepseek-ai/dsh plugin --profile web update dsh-plugins

# Uninstall the whole pack (auto-detached from the layer list)
npx @deepseek-ai/dsh plugin --profile web remove dsh-plugins
```

To temporarily disable a single plugin (no code changes): append to `~/.dsh/profiles/web/cordis.patch.yml`

```yaml
- id: tokprev
  disabled: true
```

Restart to apply.

## Publishing to GitHub (maintainers)

```powershell
git remote add origin git@github.com:PlusQi/dsh-plugins.git
git push -u origin master
git tag v0.2.0; git push --tags   # optional: tag a version users can pin
```

Push and it's installable — no registry needed. The `files` field keeps git installs to
`lib/` + `cordis.patch.yml` (pnpm automatically includes README / LICENSE / package.json when packing).

## Adding a new plugin (pack maintenance mode)

1. Add one entry to the `PLUGINS` registry in `lib/client.js`: `css` + `apply(ctx)` (helpers, components, and the `ctx.slots.inject(...)` registration block all live in this section);
2. Add one row to `cordis.patch.yml` (`name` is always `'dsh-plugins'`, `config.plugin` points to the registry key; prefix the id with your own so it never collides with dsh-base/dsh-web-app builtin ids):

   ```yaml
   - id: xxx
     name: 'dsh-plugins'
     config:
       plugin: xxx
   ```

3. Write a `SPEC-xxx.md` decision record;
4. Restart the process. **Zero install operations.**

Four hard constraints of the multi-plugin structure (from DSH itself — read before changing):

- **Client bundles are discovered by package name**: the host resolves `<name>/package.json` by the entry's `name` to read the `dsh.client` declaration, and serves the whole package via `exports["./client"]`. The row's name must be the bare package name `dsh-plugins`; a subpath like `dsh-plugins/xxx` only loads the host half (dsh-web-app's `web-startup` row is exactly this host-only subpath usage).
- **The client module graph is flat per package**: a package's client half = one module node — no splitting into multiple files (a bundle factory's `require` only knows module-table words; relative paths throw). All plugins share the single `lib/client.js` file, kept sane by section discipline — that's the boundary of "no build step".
- **Same-name rows = multiple fibers of one module**: each patch row is a fiber, each running `apply(ctx)` once; `config.plugin` dispatches to its own registration block (same pattern as dsh-base's `tool-subagent` / `tool-subagent-fork`). Without the dispatch, a second row would re-register the first plugin's slots verbatim.
- **Styles are tagged per plugin**: under multiple fibers, a pack-level shared `<style>` gets torn down by whichever fiber stops first; give each plugin its own `data-plugin-css="dsh-plugins/<id>"` tag that lives and dies with its fiber.

Outgrown the pack and want independent releases / a separate repo? Copy the registration block plus the patch row into a new package (the model is in [SPEC-tokprev.md](./docs/specs/archive/SPEC-tokprev.md) §11).

## Maintenance notes

- **No build step**: `lib/client.js` is the shipped artifact (plain JS, no TS/JSX; React is injected by the ModuleLoader). Changes = edit + restart.
- **Compatibility surface**: plugins depend on UI slot contracts (`conversation.composer.dock`, `conversation.chat.assistant-actions`) and projection fields (`contextPressure`/`contextBreakdown`/`AssistantMessageNode.usage`). If a plugin vanishes after a DSH upgrade, check these contracts first. Every read path degrades gracefully (renders null when data is missing, never throws).
- **Developed against**: DSH `@deepseek-ai/dsh 0.1.1-rc.2`.
- **Dev loop**: prototype live in a session with dynamic Cordis plugins (`cordis_define` -> `cordis_run`) first, then land it in this pack once satisfied.

## License

[MIT](./LICENSE)
