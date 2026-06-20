<p align="right">
  <a href="README.zh-CN.md">中文</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Your private control plane for AI agents.</strong><br>
  Give it a goal; Friday runs one governed loop — route → verify → approve → remember — across the AIs you bring (Codex, Claude, DeepSeek). You hold the keys.<br>
  Local-first kernel · BYOK · Approval-first · Human-controlled · Evidence-backed
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node >=22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/npm-%40thesongzhu%2Ffriday-red?style=flat-square" alt="@thesongzhu/friday">
  <img src="https://img.shields.io/badge/Release%20Truth-public%20v1%20local%20candidate-blue?style=flat-square" alt="Release Truth: public v1 local candidate">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

> **Friday is not a model, and not a chatbot.** The "brains" are the cloud AIs *you* bring (BYOK: Codex, Claude, DeepSeek, …). Friday is the **kernel that orchestrates them** — and that kernel, plus your keys, your data, and your memory, stay on your own machine. **You own the controller; you rent the brains.**

## What Is Friday?

The new way to work with AI agents isn't to prompt them yourself — it's to **design the loop that prompts them**. Friday is that loop, turned into a product and made safe:

> **finds the work → hands it to the right AI → checks it really did it → writes down what's done → decides the next thing** — so the system pokes the agents instead of you.

It is built to coordinate Codex, Claude, and DeepSeek as **governed, metered workers** — cheap models think and plan, expensive models do the heavy lifting — to keep a verifiable evidence trail, and to never let a risky action run without your signature.

## How The Loop Works

```
        your goal
           │
           ▼
   route ── pick the best AI for this step  (you can re-route)
           │
           ▼
   execute ── governed: risky steps pause for your approval
           │
           ▼
   verify ── proof it's really done  (never trust "I'm done")
           │
           ▼
   remember ── candidate → you confirm → it gets smarter
           │
           └──────────────► the next thing
```

The leg most tools skip is **verify**. An agent that grades its own work will cut corners. In Friday, "done" is meant to carry real, checkable proof — a model saying *"ok"* or a process merely exiting is **never** treated as done.

## What Makes It Different (And Hard To Copy)

Codex and Claude each give you one great agent. They won't govern *each other* for you, and they won't put the controls on your side. Friday is designed to sit one floor above them, across vendors, on your machine:

- **Cross-vendor orchestration** — one goal, the best model per step, no silent model swaps.
- **Verification, not self-report** — deterministic checks + proof receipts gate every "done".
- **Approval-first** — anything irreversible pauses for your offline signature; the kernel can only *verify* your key, it can **never** sign for you.
- **Governed memory** — long-term memory is never written silently; you confirm each fact before it sticks.
- **Metered & audited** — every model call is costed and hash-chain audited; private context is gated by an explicit passport + redaction before it can leave.

This is the seam single-vendor tools structurally won't fill: *neutral, cross-vendor, owner-side governance.*

## Why It's Built This Way

Coding agents got powerful fast — but they hit a reliability cliff on longer tasks, and they will quietly cut corners or claim work they didn't finish. The industry's shift in 2026 is **loop engineering**: stop prompting agents by hand, and instead design the system that finds work, hands it out, **checks it**, records what's done, and decides the next thing. Friday takes that idea and makes the missing parts real:

- **Verification is the load-bearing leg.** An agent grading its own work isn't trustworthy — so "done" has to carry proof, not a self-report. It's the part most tools skip, and the part Friday is built around.
- **Governance belongs on your side.** The real agent risks are well-documented — silent memory poisoning, leaking private data to the wrong place, runaway spend, destructive commands. So approval, an explicit context passport, metering, and audit live in *your* kernel, not a vendor's cloud.
- **Cross-vendor is the point.** Each vendor ships one great agent, but won't govern the others for you. A neutral layer that orchestrates them on your machine, controls on your side, is the seam a single vendor structurally won't fill.
- **The model is rented, not owned.** Friday deliberately isn't a model. Models will keep changing; the durable value is the harness around them — routing, verification, memory, and governance that stay yours.

## The Shape It's Growing Into

A private AI chief-of-staff that lives on your phone and your desktop:

- You hand it a goal in chat; it plans, routes across models, and **shows you the routing so you can change it**.
- Risky steps arrive as a **one-tap approval you sign**; safe steps just happen.
- It **learns your preferences and your world**, so it gets more useful the more you use it.
- It can watch your own coding sessions, take work in from your channels (Telegram, …), run your imported skills and workflows, and pick up scheduled work — all under the same governance.
- You hold a **trust dial**: turn it up to pre-approve batches of low-risk work, turn it down to confirm every step. Irreversible actions always ask.

You stay sovereign the whole way: **the brains are rented, the controller is yours.**

## Principles

**Local-first kernel · BYOK · Approval-first · Human-controlled · Evidence-backed**

> *Local-first* here means the **controller, your keys, your data, and your memory** live on your machine — the models themselves are cloud APIs you connect. Friday is the local **kernel**, not a local model.

## Status

Friday is a **public v1 local candidate**, distributed via npm / source. The engine and safety substrate — the goal→work spine, routing, governance, metering, audit, and sealed transport — are in place, and you bring your own keys. Capability-acquisition and self-upgrade flows are **review-gated work in progress**, not a fully-autonomous promise. Friday does the work it can safely do, **stops clearly when it needs you**, and leaves evidence behind.
