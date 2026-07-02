<p align="right">
  <a href="README.zh-CN.md">中文</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Your private control plane for AI agents.</strong><br>
  Hand it a goal. It routes each step to an AI, checks the work, asks before anything risky, and remembers what you told it — so you're steering, not babysitting. You hold the keys.<br>
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

> **Friday isn't a model, and it isn't a chatbot.** The "brains" are the cloud AIs *you* already pay for (BYOK: Codex, Claude, DeepSeek, …). Friday is the **boss that puts them to work** — and the boss, plus your keys, your data, and your memory, all live on your own machine. **You own the boss; you just rent the brains.**

## Quickstart

Friday runs from source today and requires Node.js 22 or newer.

On macOS with Homebrew:

```bash
brew install node@22
git clone https://github.com/thesongzhu/Friday.git
cd Friday
open "Friday Setup.command"
```

If setup reports an older or missing Node.js, install Node.js 22+, then run `Friday Setup.command` again.

## What Is Friday?

The trick with AI agents isn't prompting them yourself all day — it's building **the loop that prompts them for you**. Friday is that loop, turned into a product and made safe:

> **finds the work → hands it to an AI → checks it actually did it → writes down what's done → picks the next thing** — the system nags the agents, so you don't have to.

Under the hood it runs Codex, Claude, and DeepSeek like a **metered crew** — cheap models do the thinking and planning, pricey ones do the heavy lifting — keeps the receipts, and hits pause on anything risky until you say go.

## How The Loop Works

```
        your goal
           │
           ▼
   route ── pick an AI for this step  (you can re-route)
           │
           ▼
   execute ── governed: risky steps pause for your approval
           │
           ▼
   verify ── prove it's really done  (don't trust "I'm done")
           │
           ▼
   remember ── candidate → you confirm → it remembers
           │
           └──────────────► the next thing
```

The leg everyone else skips is **verify**. An agent grading its own homework will absolutely cut corners — so in Friday, "done" has to come with a **receipt stapled to it**. A model saying *"ok,"* or a process that just quietly exits, doesn't count on its own.

Two more things keep it from feeling like a dumb dispatcher: if your goal is vague, Friday **asks you what you actually meant** instead of guessing — and burns zero tokens until it's clear; and when a job needs both coding *and* big-picture synthesis, it can let one model write the code and only tap a second one in **once the first has proven it's done**.

## What Makes It Different (And Hard To Copy)

Codex and Claude each hand you one great agent. Neither will police the *other* for you, and neither puts the controls on your side. Friday sits one floor up — across vendors, on your machine — with a few guarantees that are **baked into how it's built**, not a checkbox the same program could flip on itself:

- **We never gave Friday a pen.** It carries the key that *checks* your signature, never the one that *writes* one — so on anything dangerous it can't fake your "yes"; the sign-off has to come from your own hand, offline, on your own device.
- **A model can't wave its own risky move through.** Plain read-only stuff never needs your sign-off, but anything that changes the world — or smells risky — can only ever land on *needs your OK* or *nope* inside the kernel, never *sure, go ahead*. And an agent can't rubber-stamp its own side effects.
- **"Done" is never just a model's word for it.** A task can't flip to "complete" unless a proof receipt is attached through Friday's persisted mission/work-item code boundary. The database stores those refs; the application boundary rejects receipt-free completion. No receipt, no done.
- **Nothing becomes a real memory behind your back.** Friday floats facts as *candidates*; not one graduates to a real memory until you say yes — so a poisoned "fact" just sits there, harmless. And when it recalls something, it's yours only, scrubbed of known secret patterns before any model sees it.
- **No sneaky model swaps.** Friday picks each model with a quick, free, zero-token decision *before* it spends a cent; and if it ever has to fall back to a backup, the bill honestly says which model actually answered. It never quietly swaps in something else and hands you a mystery charge.
- **Tamper-evident on purpose.** Every routed agent turn lands as one all-or-nothing entry — who, what, how much — in a hash-chained audit log, so quietly editing the past snaps the chain.

This is the gap a single-vendor tool will never close for you: **a neutral referee, across vendors, on your side.**

## Why It's Built This Way

Coding agents got scary-good scary-fast — but they still hit a wall on long jobs, and they'll cheerfully cut corners or claim they finished something they didn't. The 2026 shift is **loop engineering**: stop hand-prompting agents, and build the system that finds the work, hands it out, **checks it**, records what's done, and picks what's next. Friday takes that idea and builds the missing pieces for real:

- **Verification is the whole ballgame.** An agent that grades itself can't be trusted — so "done" has to come with proof, not a pinky-promise. It's the part most tools skip, and the part Friday is built around.
- **Governance belongs on your side of the table.** The horror stories are well-documented — memory quietly poisoned, private data sent somewhere it shouldn't, spend running away, a destructive command. So approval, a context passport, metering, and audit all live in *your* kernel, not some vendor's cloud.
- **Cross-vendor is the whole point.** Every vendor gives you one great agent and zero interest in refereeing the others. A neutral layer that runs them on your machine, controls on your side, is the seam none of them will fill.
- **The model is rented, not married.** Friday deliberately isn't a model. Models change every few months; the lasting value is the harness around them — routing, verification, memory, governance — and that part stays yours.

## The Shape It's Growing Into

A private AI chief-of-staff that lives on your phone and your desktop:

- Hand it a goal in chat; it plans, spreads the work across models, and **shows you who it picked so you can overrule it**.
- Risky steps show up as a **one-tap thing you sign**; safe stuff just happens. You also get a **trust dial** — crank it up to pre-approve batches of low-risk work, down to confirm every step. Irreversible things always ask.
- It's **built to get to know you the more you use it** — turning finished work into a feel for your preferences and your world that, once *you* confirm it, is wired to quietly color later runs (that part isn't switched on yet, and reflexes stay on their own governed leash).
- **Skills are welcome but kept on a leash**: bring a reviewed skill, sign to switch it on, and it only runs after you sign off on that exact use — boxed into its own little sandbox. Friday won't write skills for you; it just governs the ones you bring.
- Every agent — **and every sidekick it spins up** — is built to run inside a revocable trust grant with spend, run, and tool limits, where a child can never get *wider* powers than its parent.
- It can look over your shoulder while you code, take jobs in from your channels (Telegram, …), and pick up scheduled work — all under the same rules.

You stay the boss the whole way: **the brains are rented, the controller is yours.**

## Principles

**Local-first kernel · BYOK · Approval-first · Human-controlled · Evidence-backed**

> *Local-first* here means the **controller, your keys, your data, and your memory** live on your machine — the models themselves are cloud APIs you plug in. Friday is the local **kernel**, not a local model.

## Status

Friday is a **public v1 local candidate**, shipped from source; the source tree is 1.0.3, while the npm package currently lags at 1.0.2, an earlier package line. The engine and safety substrate — the goal→work spine, routing, governance, metering, audit, and sealed transport — are all in place, and you bring your own keys. Fair warning, since honesty is the whole point: the guarantees above are properties of how it's built *today* in this source tree, not a claim that the older npm artifact already carries every current engine change; the live behaviors have so far only run on internal and self-test traffic, **not real end-user workloads**, and the more autonomous bits ship dark behind off-by-default flags. Capability-acquisition and self-upgrade are **review-gated works in progress**, not a full-autopilot promise. Friday does what it can safely do, **stops clearly when it needs you**, and always leaves the receipts.
