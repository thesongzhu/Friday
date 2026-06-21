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

It is built to coordinate Codex, Claude, and DeepSeek as **governed, metered workers** — cheap models think and plan, expensive models do the heavy lifting — to keep a verifiable evidence trail, and to pause risky actions for your sign-off.

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

The leg most tools skip is **verify**. An agent that grades its own work will cut corners. In Friday, "done" has to carry an attached proof receipt — a model saying *"ok"* or a process merely exiting is **never**, on its own, treated as done.

Two things make the loop feel less like a dispatcher: if your goal is ambiguous, Friday hands back **specific clarifying questions** instead of guessing — and spends nothing until it's clear; and when a task needs both code and synthesis, it can run the code leg on one model and only hand off to another **once the first is proven done**.

## What Makes It Different (And Hard To Copy)

Codex and Claude each give you one great agent. They won't govern *each other* for you, and they won't put the controls on your side. Friday is designed to sit one floor above them, across vendors, on your machine — with guarantees that hold *by construction*, not by an honor-system flag the same process could flip:

- **On the path that guards your dangerous actions, the kernel can't sign for you.** It holds only your public verification key — never the private key that signs — so a dangerous action stays locked until *you* sign it, offline, on your own device.
- **A model can never wave its own risky action through.** Read-only steps never need your sign-off, but anything that mutates or carries risk can only ever become *needs your approval* or *denied* in the kernel — never *allowed* — and an agent can never approve its own side effects.
- **"Done" is never a model's say-so.** A task can't be marked complete unless a proof receipt is attached to its record — enforced at the data layer beneath the code, where no write path can route around the check. No receipt, no completion.
- **No fact is written to memory behind your back.** Friday proposes facts as candidates; nothing enters long-term memory until you confirm it, so a poisoned "fact" stays inert — and recall is isolated to you and redacted before it reaches any model.
- **No silent model swaps.** Each model is chosen by a deterministic, zero-cost decision before any spend; and if it ever fails over to a backup, the turn is honestly attributed to whichever model actually answered. It never quietly substitutes a model and bills you opaquely.
- **Tamper-evident by design.** Every routed model call is metered as one attributed, all-or-nothing record, and the audit log is hash-chained — so altering any past entry breaks the chain.

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
- Risky steps arrive as a **one-tap approval you sign**; safe steps just happen — and you hold a **trust dial**: turn it up to pre-approve batches of low-risk work, down to confirm every step. Irreversible actions always ask.
- It **gets to know you the more you use it** — distilling your preferences and a model of your world from finished work that, once *you* confirm them, quietly shape later runs (reflexes kept governed and separate).
- **Skills are first-class but leashed**: import a reviewed skill, sign to promote it, and it runs only after you sign the exact invocation, inside a sandbox confined to that skill. Friday doesn't auto-write skills — it governs the ones you bring.
- Every agent — **and every sub-agent it spawns** — is built to run inside a revocable trust grant with spend, run, and tool ceilings, where a child grant can never be *wider* than its parent.
- It can watch your own coding sessions, take work in from your channels (Telegram, …), and pick up scheduled work — all under the same governance.

You stay sovereign the whole way: **the brains are rented, the controller is yours.**

## Principles

**Local-first kernel · BYOK · Approval-first · Human-controlled · Evidence-backed**

> *Local-first* here means the **controller, your keys, your data, and your memory** live on your machine — the models themselves are cloud APIs you connect. Friday is the local **kernel**, not a local model.

## Status

Friday is a **public v1 local candidate**, distributed via npm / source. The engine and safety substrate — the goal→work spine, routing, governance, metering, audit, and sealed transport — are in place, and you bring your own keys. The structural guarantees in this README are properties of the current build; the runtime behaviors have so far been exercised on internal and self-test traffic, **not yet on real end-user workloads**, and the more autonomous capabilities ship dark behind default-off flags. Capability-acquisition and self-upgrade are **review-gated work in progress**, not a fully-autonomous promise. Friday does the work it can safely do, **stops clearly when it needs you**, and leaves evidence behind.
