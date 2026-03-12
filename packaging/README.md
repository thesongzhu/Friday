# Friday Packaging Matrix

This directory tracks the packaging inputs for the cross-platform Friday download story.

Current truth:

- `macOS`: real native companion exists and DMG packaging is wired through the release scripts.
- `Windows`: native companion and MSI channel are scaffolded here, but not yet release-complete.
- `Linux`: native companion and AppImage/DEB channel are scaffolded here, but not yet release-complete.

Package manager and installer templates live here so tagged releases can render concrete manifests from release metadata without changing the public `/v1/system/*` contract.
