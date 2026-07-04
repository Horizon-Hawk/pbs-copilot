---
tags: [pbs, copilot, architecture]
updated: 2026-07-03
---

# Copilot Bid Architecture

How the extension turns a plain-English request into a NavBlue bid. See [[NavBlue Bid System]]
for the command catalog.

## Pipeline

```
Your English  ──▶  [Sonnet parse]  ──▶  constraints (JSON)
                                          + line_conditions (canonical keys)
                                          + unsupported[]  (never silently drop)
constraints + pairings  ──▶  candidate hard-filter (length / avoided cities / redeyes / absences)
candidates  ──▶  [Sonnet SELECT trips]  ──▶  validate (enforce spacing/overlap) + credit-floor check
                     │ (if invalid/short) ▼
                 [deterministic optimizer]  ──▶  optimal spaced picks
picks + constraints  ──▶  bid model  ──▶  buildBidXml()  ──▶  submit
```

Files (all in `extension/sidebar/`):
- `claude_client.js` — parse, selection, translate to bid model
- `bid_builder.js` — bid model → NavBlue `<BidLines>` XML
- `navblue.js` — session client (person data, submit)
- `sidebar.js` — UI, pairing parsing, period guard

## Two brains, by design (chosen 2026-07-03)

- **LLM picks trips (primary)** — Sonnet gets the candidate table with day-of-week/weekend flags
  pre-computed + your raw request (so it honors soft preferences). Shows a one-line reasoning.
- **Optimizer backs up** — a bounded, pruned exhaustive search that finds the provably-optimal
  spaced subset. Runs if the LLM's picks are missing / overlap / miss the credit floor.
- Status line shows `🤖 AI` or `⚙ optimizer` so you know which chose.

Hard constraints (length, avoided cities, ≥minGap spacing, non-overlap, absences, credit floor)
are enforced in JS regardless of which brain picks — a bid is always valid.

## What "max days off" means here

Minimize days worked while clearing the 75h credit floor, keeping trips ≥ `min_days_between` apart,
non-overlapping, preferring weekend-free trips. (Verified: weekend-free maxes at 72:59h in JUL26;
the true optimum uses exactly 1 weekend trip to reach 75h — the optimizer finds it.)

## Line conditions ("set conditions")

Parser emits canonical NavBlue keys; `translateLineConditions()` maps them; `buildLineCondition()`
emits valued (`<Days>`/`<Time>`) or generic-simple (`<KEY></KEY>`) XML. Unknown asks → `unsupported`,
surfaced in the build status, never dropped.

## Status: what works vs. caveats

WORKS (verified): city-avoid (LandingsIn), weekends-off, cherry-pick single group, date-aware
selection, min base layover (TimeBetweenPairings), min credit window (MinimumCredit), full parse
of the failing request.

CAVEATS: naked line-condition XML matches NavBlue's serialization but is **not yet live-submitted**
— preview + Default-target submit first. Full 177-option coverage still needs each valued widget's
XML wired (simple conditions are all covered generically).

## Backend

`/api/claude` (Vercel, `pbs-copilot-backend`) proxies to Anthropic. Licensing/LemonSqueezy removed.
Only `backend/` changes trigger a Vercel redeploy; extension edits just need an extension reload
(+ close/reopen the side panel — it caches module code).
