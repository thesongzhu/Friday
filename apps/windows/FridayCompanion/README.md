# Friday Companion for Windows

This directory holds the first native Windows companion scaffold for Friday Agent OS.

Current scope:

- native process startup contract
- heartbeat and health reporting shell
- room for WinUI/system-tray integration

Not yet complete:

- real tray UI
- global hotkeys
- MSI release packaging
- full Windows desktop automation parity with macOS

The production bridge contract remains the shared Unix domain or named-pipe JSON-RPC surface defined in the core Friday system runtime.
