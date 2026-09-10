# dsh-plugins

[简体中文](./README.md) | English

A repository of possibly useful [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugins.

All plugins live in a single pack (one repo = one profile bundle): install once and they are all in — no per-plugin install.

## Plugins

| Plugin      | Function                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------- |
| **tokprev** | "Next-turn input preview" below the Composer (context + queued + draft, live as you type) + a real usage badge on each turn's closing message (provider-reported: input / cache / output / call count) |
| **tokstats** | Sidebar-footer button + popover: cross-session token consumption stats (period overview / by workspace / by model with cost / context-length buckets, today · this week · total switch) |
| **promptopt** | Star-icon button in the composer's tool row (hover for the tooltip): hand the draft to the model for a rewrite before sending, compare original vs. optimized, and **adopt** it into the input only if you like it |

> **tokprev** is a pure interface plugin; **tokstats** and **promptopt** also ship a host-side half (one aggregates session logs in the background, the other makes a single side-channel model call).

## Language (Chinese / English)

Plugins render their copy through the host locale service and **follow DSH Settings → General → Language**; the pack itself has no language switch.

- Dictionaries are namespaced per plugin — `dsh-plugins.tokprev`, `dsh-plugins.tokstats` and `dsh-plugins.promptopt`.
- promptopt splits **two axes**: UI copy follows the host language, while the **rewritten prompt follows the draft's language** (a Chinese draft still comes back Chinese on an English UI) — the rewrite is content, not UI copy.
- With no explicit choice the host falls back to the browser language, and to en when it is neither zh nor en.
- `locale` is a **hard dependency** (as in official UI packs): when the host has no locale service (or it is disabled by hand), the whole bundle does not load — the UI disappears with no log line, rather than showing half-translated copy.
- Number notation (1.2K / 3.4M), context bucket ranges (`[0,4K)`) and the ¥ sign are not translated (they read the same in English, and ¥ is DeepSeek's official RMB pricing — CNY would mislead); the panel footer clock is fixed 24-hour, independent of the browser locale.

## tokprev

A closed loop for per-turn token consumption: before you send, it tells you roughly how many tokens the next turn will feed in; after the turn ends, it reconciles with provider-reported actuals.

![tokprev in action](./docs/assets/tokprev-en.png)

Note: the badges below are annotated on the English UI; the copy labels are translated by the host locale service.

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

## tokstats

Cross-session token consumption stats: the host's StatsLine only sees one session; this plugin scans every durable session log to answer "how much did I burn today", "which project eats the most", "how often do I run long contexts".

![tokstats panel](./docs/assets/tokstats-en.png)

A "Token stats" button at the sidebar footer (an icon seat in rail mode) opens a popover panel:

- **Overview**: today / this week (Monday-based) / total — call count and the four buckets (tokens only, no money);
- **By workspace**: top 8 (subagent usage merges up the parent chain into the root workspace; fork seed prefixes are deduplicated, never double-counted);
- **By model**: provider/model rows with an estimated cost column (a "no price" marker when unpriced);
- **Context length distribution**: billed input binned into power-of-two buckets `[0,4K)…[128K,∞)` with requests / input / output / cache-hit rate.

Same accounting as the host: billed input = `inputTokens + cacheReadTokens + cacheWriteTokens`; the final `assistant/message.usage` of a `(turn, step)` replaces its usage-chunk sample (no double counting). Money figures are **estimates**: built-in DeepSeek official peak rates (CNY/Mtok, overridable), and the panel says so.

Right after the first install the panel shows "Scanning…" until some session is opened (or a stats push arrives); missing host-side services show an explanatory note instead of an error.

### Pricing config (optional)

Built-in prices only cover the `deepseek-official` route. For third-party providers, append to your profile patch (`~/.dsh/profiles/web/cordis.patch.yml`, CNY/Mtok):

```yaml
- id: tokstats
  patch:
    config:
      prices:
        ark-codingplan:
          glm-5.3: { input: 2, inputCached: 0.2, output: 4 }
```

## promptopt

After typing a draft you no longer need a separate "please optimize this prompt" turn: hit the **star icon** in the tool row (hover for the tooltip, which changes to a reason when disabled), the model rewrites it, you compare original vs. optimized, and **adopt** it into the input only when you are happy. Close it and the draft is untouched.

- **Where it lives**: the right end of the composer card's **internal** tool row — between the model select and the send button, where your hand already is on the way to sending.
- **Flow**: click (popover opens, spinner) → result arrives (original vs. optimized + elapsed time) → adopt or close. Closing, Esc, and clicking outside all count as cancel and abort the in-flight call.
- **Disabled** (greyed out, with a tooltip explaining why): the draft is empty, or it contains a reference chip, an image attachment, or a `/` command token — adopting is a full-text replacement, so a model reshuffle would break reference offsets and image ownership. That is silent corruption, so the button simply refuses.
- **Adopt semantics**: the snapshot taken when you clicked wins, and it is written back unconditionally. If you edited the draft while waiting, adopting overwrites those edits (no confirmation dialog).
- **Model and cost**: one **side-channel call** through the host's `ctx.llm`, riding the first registered provider/model route. **No configuration surface** and no API key of its own; each click is one model call (input on the order of 1.5x the draft).
- **Nothing on disk**: no checkpoint, no session log — purely in-memory. This call is **not** counted by tokstats (it never lands in the durable session log).
- **Degrades**: when the model service is absent, clicking shows "The model call failed — please try again" instead of a blank screen.

If the button does nothing or always errors after a DSH upgrade, check the host-contract list in the maintenance doc first.

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

Restart to apply. Note: `disabled` removes that row's **host-side** fiber only — whether the browser-side UI unloads depends on **whether any row of the pack is still live**, so for a pure-interface plugin like tokprev, disabling one row does **not** make it disappear from the page. For a real per-plugin off-switch, split the plugin into its own package (rationale and steps in the maintenance doc).

## Maintenance

This file is for users. Maintainers and AI agents start from [AGENTS.md](./AGENTS.md) (routing table + hard rules + structural guard); the publishing flow, the four steps for adding a plugin, the four hard constraints of the multi-plugin structure, each plugin's host-side behavior and host contracts, and the real semantics of the per-plugin switch live in [docs/MAINTAINING.md](./docs/MAINTAINING.md). Release history: [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
