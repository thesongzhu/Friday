# Friday Doc Drift List (2026-04-16)

## Still Drifting Or Needs Refresh

1. `docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-16.*`
   - Still marks `search latestness` as `not proven`
   - New live proof now exists through MCP `web_search` with dated Google News RSS results

2. `docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-16.*`
   - Still treats heartbeat only as a status-route surface
   - New live proof now exists for `POST /v1/heartbeat/trigger` in an env-on runtime

3. `/Users/jarvis/Desktop/Friday-3天变更报告-2026-04-12至15.md`
   - Must remain input-only
   - Claims like `10,016 tests passing` and earlier “line-by-line review” language are not acceptable as release truth

4. Any UI/help copy that implies marketplace is browse-ready
   - Current live runtime:
     - `catalog=0`
     - `sources=0`
     - `assets=0`
   - Marketplace remains hidden from public surface

5. Any copy implying desktop is ready by default
   - Current live runtime still reports `safe_mode / degraded`
   - Missing permissions remain the blocking reason

6. Any copy implying all channels are usable
   - Real proof only exists for `webchat` and `irc`
   - Other channel kinds remain code surfaces or credential-gated surfaces
