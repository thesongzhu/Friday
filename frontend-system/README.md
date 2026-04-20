# Friday Frontend System

This folder is a complete handoff package for the next-generation Friday console.

It does four things:
- fixes the information architecture around one console, one shared conversation, and gradual disclosure
- maps every user-meaningful capability except Marketplace to a visible surface
- defines the design-system layers needed to implement the console consistently
- gives engineering or outsourcing teams a build-ready blueprint without asking them to make product decisions

Working assumptions:
- keep the current `ui/` direction centered on `AppShell` plus a persistent right chat rail
- do not create a separate Pro/Admin mode
- do not productize internal plumbing
- do not include Marketplace in the required surface map for this delivery

Directory guide:
- `vision/`: product intent, user types, console principles
- `architecture/`: IA, navigation, right-rail model, layout rules, mobile mapping
- `capability-map/`: capability registry and visibility rules
- `tokens/`: source-of-truth visual tokens and usage rules
- `components/`: component semantics and rules
- `patterns/`: layout and interaction patterns
- `pages/`: 10 first-level page blueprints
- `previews/`: static preview shells and page samples
- `src/`: implementation skeleton compatible with the current React/Vite app
- `handoff/`: build order, QA, copy, responsive, and outsourcing constraints

Relationship to the current product:
- current `ui/src/components/layout/app-shell.tsx` already establishes the core shell direction
- current routes already cover most capability areas that matter to users
- this folder formalizes that direction and closes the remaining product and layout ambiguity
