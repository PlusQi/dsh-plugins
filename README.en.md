# dsh-plugins

[简体中文](./README.md) | English

Personal extension pack for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).
One repo = one profile bundle: all plugins live in a single pack — adding a plugin is just code + a restart, no reinstall.

## Plugins

| Plugin      | Function                                                                                          | Design spec                          |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **tokprev** | "Next-turn input preview" below the Composer (context + queued + draft, live as you type) + a real usage badge on each turn's closing message (provider-reported: input / cache / output / call count) | SPEC-tokprev.md |

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
npx @deepseek-ai/dsh plugin --profile web add github:PlusQi/dsh-plugins#v0.2.3

# Local dev link (edit + restart to see changes; replace with your local repo path)
npx @deepseek-ai/dsh plugin --profile web add link:D:\path\to\dsh-plugins
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

Restart to apply. Note the row's real semantics: `disabled` removes that row's **host-side** fiber only — whether the browser bundle loads depends on **whether any row of the pack is still live** (DSH's boot graph keys on package name; the client has one fiber per package that registers ALL plugins unconditionally). While tokprev is the pack's only plugin, disabling its row takes the whole pack down — intuitive. Once the pack has multiple plugins, disabling one row does **not** remove that plugin's browser UI (the remaining rows keep the whole bundle alive). For a per-plugin off-switch, split the plugin into its own package (see the end of "Adding a new plugin" below).

## Publishing to GitHub (maintainers)

```powershell
git remote add origin git@github.com:PlusQi/dsh-plugins.git
git push -u origin master
git tag v0.2.0; git push --tags   # optional: tag a version users can pin
```

**Hard gate before tagging** (the lesson of v0.2.0's three failed rounds — see the [postmortem](./docs/debug/postmortem-v0.2.md)): link-install the target commit -> restart dsh web -> reload the page and visually verify **every plugin's** UI elements actually render. "Boots without errors ≠ plugin works" — slot registration is a side effect; an apply that returns early or throws can fail silently. No green visual check, no tag.

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
- **Host gets one fiber per row; the client gets one fiber per package**: each patch row creates a **host** fiber, and `config.plugin` is a host-plane dispatch key (dsh-base's `tool-subagent` / `tool-subagent-fork` — a host-only package — is the same-name multi-row reference; this pack's host half is empty, so rows act as presence / disable anchors). The **client-side `__DSH_BOOT__` manifest creates ONE entry per package with no config** (`dsh-client-modules` builds its boot graph keyed by package name), so `lib/client.js`'s apply registers ALL `PLUGINS` entries unconditionally and components return null when their data is missing. There is no "second row runs apply again" client-side, and dispatching by `config.plugin` in the client is impossible.
- **Styles are tagged per plugin**: give each plugin its own `data-plugin-css="dsh-plugins/<id>"` tag (`ensurePluginStyles` idempotent insert, removed when the pack fiber stops); this keeps per-plugin granularity so a plugin split out into its own package later takes its styles along verbatim.

Outgrown the pack and want independent releases / a separate repo? Copy the registration block plus the patch row into a new package (the model is in the local SPEC-tokprev §11).

## Maintenance notes

- **No build step**: `lib/client.js` is the shipped artifact (plain JS, no TS/JSX; React is injected by the ModuleLoader). Changes = edit + restart.
- **Compatibility surface**: plugins depend on UI slot contracts (`conversation.composer.dock`, `conversation.chat.assistant-actions`) and projection fields (`contextPressure`/`contextBreakdown`/`AssistantMessageNode.usage`). If a plugin vanishes after a DSH upgrade, check these contracts first. Every read path degrades gracefully (renders null when data is missing, never throws).
- **Developed against**: DSH `@deepseek-ai/dsh 0.1.1-rc.2`.
- **Dev loop**: prototype live in a session with dynamic Cordis plugins (`cordis_define` -> `cordis_run`) first, then land it in this pack once satisfied.

## License

[MIT](./LICENSE)
