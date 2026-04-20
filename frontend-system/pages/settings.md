# Settings

Target users:
- builders
- trust owners
- runtime operators

Page tasks:
- configure providers and routing
- manage security, secrets, grants, and tokens
- inspect system runtime, setup, and utility tools

Module order:
1. Settings domain switcher
2. Providers and routing
3. Security center
4. Secrets, grants, and tokens
5. Runtime and system setup
6. Utility tools and diagnostics

Desktop layout:
- domain navigation inside the page
- section content in stacked cards or list-detail when needed

Mobile mapping:
- segmented domain switcher
- stacked domain sections
- sensitive edits inside sheets with confirmation

Right-rail chat linkage:
- inject current settings domain, selected provider or secret scope, current warnings
- quick actions: compare providers, explain routing, create safe secret checklist

States:
- loading: domain nav and section skeletons
- empty: only for optional subsections, never for the whole page
- error: preserve domain switcher and last-known values where safe
- partial: sensitive values redacted while metadata still loads
- success: runtime control and security posture are understandable without log spelunking

Forbidden:
- no admin-only jargon as primary labels
- no settings group by backend package name
- no secrets or tokens displayed without role, scope, and action semantics
