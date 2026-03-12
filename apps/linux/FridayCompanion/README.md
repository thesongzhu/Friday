# Friday Companion for Linux

This directory holds the first native Linux companion scaffold for Friday Agent OS.

Current scope:

- native process startup contract
- heartbeat and health reporting shell
- room for GTK or tray integration

Not yet complete:

- AppIndicator or tray UI
- Linux desktop-environment specific automation backends
- AppImage and DEB release packaging
- full Linux desktop automation parity with macOS

The production bridge contract remains the shared Unix socket JSON-RPC surface defined in the core Friday system runtime.
