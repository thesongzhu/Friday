# Integrations

Target users:
- builders and operators connecting Friday to tools, channels, and extensibility surfaces

Page tasks:
- browse Packs, Skills, Plugins, MCP, and Channels
- understand connection health
- enable or configure the right extension path

Module order:
1. Integration overview and health summary
2. Section switcher: Packs, Skills, Plugins, MCP, Channels
3. Current section list
4. Selected item detail
5. Setup or diagnostics actions

Desktop layout:
- top overview strip
- section switcher under header
- list-detail body

Mobile mapping:
- switcher at top
- one-column cards
- detail in drill-in view

Right-rail chat linkage:
- inject current integration type, selected item, health status, setup blockers
- quick actions: configure this, compare options, diagnose connection

States:
- loading: overview and list skeleton
- empty: explain the difference between the five integration types
- error: keep health summary and setup actions available
- partial: list works even if detail or health telemetry lags
- success: list, detail, and diagnostics align

Forbidden:
- no mixing Marketplace content into this page
- no hiding MCP or Channels under generic settings
- no plugin health that only exists in logs
