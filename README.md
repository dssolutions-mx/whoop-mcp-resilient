# whoop-mcp-resilient

An MCP server that gives Claude (and other MCP clients) read-only access to your WHOOP data: recovery, HRV, sleep, strain, workouts, cycles, trends and period comparisons.

> **Based on [whoop-ai-mcp](https://github.com/shashankswe2020-ux/whoop-mcp) by Shashank Mishra** (MIT). This is an independent fork, not affiliated with the original project or with WHOOP. It keeps the original's 16 tools and adds reliability, correctness and efficiency fixes found while running it daily against a real account. Full credit for the original design goes to the upstream author.

## Why this fork

The original server works well on a good day. These are the failures that made it unusable on a bad one, all reproduced against the live WHOOP API and fixed with tests:

| Problem | What users saw | Fix |
|---|---|---|
| WHOOP's origin intermittently returns HTTP 500 while other requests succeed | Random tool failures | Retries 5xx and network errors/timeouts (not just 429) with jittered exponential backoff |
| Parallel 401s each refreshed the token; WHOOP rotates refresh tokens, so all but one got a dead token | A session that "dies" until the app is restarted | Single-flight refresh, adopts a newer token another process already saved, recovers from a lost refresh race, atomic token file writes |
| WHOOP sends `null` for workout distance/altitude without GPS, and `next_token: null` on the last page | `WHOOP data did not match the expected output contract` on swims, climbs, gym sessions and most short queries | Contracts accept WHOOP's nulls; last page no longer reported as truncated |
| WHOOP's v2 API returns 404 for date-only values like `2026-09-15` | Silent failures when the model passes a plain date | Plain dates expand to the full UTC day |
| `compare_periods` accepted only strict ISO while every other tool accepts `"last week"` | Validation errors on natural requests | Accepts the same relative expressions as the other tools |
| Errors were generic ("unexpected error", "retry later or verify authorization") | The model couldn't tell an outage from a bad date | Clear messages: WHOOP outage vs rate limit vs auth vs invalid date (with accepted formats). Response bodies are still never exposed |
| Pretty-printed JSON in every tool result | ~28% of every response was whitespace | Compact JSON (same data, ~28% fewer tokens, measured on real responses) |
| Opt-in telemetry pointed at the original author's collector | Users of a fork reporting to someone else's dashboard | No built-in endpoint. Telemetry is only offered if you configure your own `WHOOP_MCP_TELEMETRY_ENDPOINT` |

## Setup

1. Create a WHOOP developer app at [developer.whoop.com](https://developer.whoop.com) and add the redirect URI `http://localhost:3000/callback`. Note its Client ID and Client Secret.
2. Add the server to your MCP client. For Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["-y", "github:dssolutions-mx/whoop-mcp-resilient"],
      "env": {
        "WHOOP_CLIENT_ID": "your_client_id",
        "WHOOP_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add whoop -e WHOOP_CLIENT_ID=your_client_id -e WHOOP_CLIENT_SECRET=your_client_secret -- npx -y github:dssolutions-mx/whoop-mcp-resilient
```

3. Restart the client. On first use a browser window opens to authorize with WHOOP. Tokens are cached at `~/.whoop-mcp/tokens.json` (mode `0600`) and refresh automatically.

**Port 3000** is only used for the few seconds of that first browser authorization. If something else is running on it, stop it for that moment.

### Run from a local clone instead

```bash
git clone https://github.com/dssolutions-mx/whoop-mcp-resilient.git
cd whoop-mcp-resilient
npm ci
npm run build
```

Then use `"command": "node"` with `"args": ["/absolute/path/to/whoop-mcp-resilient/dist/index.js"]`.

## Tools

`get_today`, `get_calendar`, `get_weekly_summary`, `compare_periods`, `get_trend`, `get_baselines`, `get_sleep_debt`, `get_recovery_collection`, `get_sleep_collection`, `get_workout_collection`, `get_cycle_collection`, `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`, `get_profile`, `get_body_measurement`.

Date parameters accept ISO 8601 (`2026-09-15`, `2026-09-15T06:00:00Z`) or relative expressions: `today`, `yesterday`, `last 7 days`, `this week`, `last week`, `last month`, `2026-09`.

Prefer the composite tools (`get_today`, `get_calendar`, `get_weekly_summary`) when you can. They bundle several data types into one call.

## Development

```bash
npm ci
npm test          # 898 tests
npm run typecheck
npm run lint
```

See [CHANGELOG.md](CHANGELOG.md) for the full list of changes relative to upstream v0.8.2.

## License

MIT. See [LICENSE](LICENSE): it retains the original copyright notice for whoop-ai-mcp alongside the notice for this fork's modifications.
