# DESIGN — Coaching Logic for the Portfolio Focus Coach

Authored by Fable 5. Companion to `PLAN.md` (the build) and `data/portfolio.json`
(the state of record).

---

## 1. Diagnosis

Your correction is right, and it's the load-bearing insight: **this is not a decision
bottleneck, it's execution avoidance on one category of un-delegatable ops work.**
You accept ~90% of recommendations within minutes of seeing them — a decision queue
would be solving a problem you don't have. Three sharpenings:

**1a. The avoidance is structural, not lazy.** Your entire workflow is built on
delegation: Fable plans, Sonnet/Opus build, you direct. DB/hosting setup is the *one*
recurring task where no agent can carry you — it's you, alone, clicking through
hPanel. It's a different job than the one you've optimized your identity and tooling
around, and it feels like a demotion every time. That's why 20 minutes of clicking
loses to hours of "productive" new-repo planning: starting a repo delivers delegated
progress and novelty; DB setup delivers neither. The coach can't make hPanel
delegatable, but it can make the session *warm-start* (everything pre-computed,
zero recall required) and *batched* (3 DBs on the same Hostinger account in one
sitting amortizes the panel-relearning cost — ~45 min for three, not 90).

**1b. The 9 untouched repos are not a separate problem — they're the avoidance
mechanism.** Starting new repos is what you do *instead of* DB setup. So the scope
review ("should `anillos` exist?") and the DB nudge are the same intervention from
two sides: reduce the supply of escape hatches, lower the cost of the avoided task.
The coach should treat a new-repo impulse as a signal to re-surface the top prepped
DB session, not as neutral activity.

**1c. The economics are absurd in your favor and the coach should keep saying so.**
~4–6 cumulative hours of hPanel work stands between you and launching roughly 40% of
everything you own. No other use of your time in the portfolio comes close to that
ROI. Every nudge should carry this framing implicitly: not "you're behind" but "this
is the cheapest launch you will ever get."

**One honest caveat on the settled architecture** (you asked to be told): it's sound,
with two mechanics to design around, not against. (i) A fresh Routine session must
not re-audit 53 repos per run — too slow and expensive. Fix: `portfolio.json` in this
repo is the state of record; the daily run reads it plus the live-doc, and only a
weekly deeper run refreshes it from git activity. (ii) Live-doc republish replaces
page content, so before any republish the runner must first read the current page
(WebFetch), harvest your checked state into `portfolio.json`, and bake it into the
new render — check-state lives in the JSON, the page is a projection of it. Both are
handled in the design below. Also: **no real credentials ever go on the live-doc** —
runbooks use `<PASTE_PASSWORD>` placeholders; secrets stay in your password manager
and local `.env` files.

---

## 2. The live-doc dashboard

One page, phone-first, six sections, in this order. Everything interactive is a
checkbox or short text field (live-doc gestures persist and are readable back).

### 2.1 Today's One Thing (the whole point)
A single prepped action card. Usually: a DB session for 1–3 repos batched by
Hostinger account. Contains:
- Headline: "45 min unblocks 3 launches: `besikt`, `idioma`, `qr`" + why-now line.
- ☐ **Booked** (with a short text field: "when?") · ☐ **Done**
- A collapsed runbook per repo: exact DB name to create, exact user, the IP to
  whitelist, env var strings ready to paste (password placeholders), migration/seed
  commands in order, and the one-line verify command. Generated from `runbooks/`.
- An honest escape hatch: ☐ **Not today — shrink it** (tomorrow's card becomes the
  smallest sub-step, e.g. "just create the DB + whitelist the IP for besikt: 5 min").

### 2.2 Launch queue
The owner-blocked ≥70% list, ranked by leverage score (§4). Per row: repo, %,
blocker category, estimated minutes, and what it unblocks (revenue / sibling repos /
nothing yet). One checkbox per blocker so partial progress registers.

### 2.3 Quick decisions inbox
Categories 3–5 from the blocker taxonomy (integration creds to schedule, business
facts, plan confirmations), batched. Each item shows the **recommended answer
pre-filled** with ☐ Accept and an optional correction field. Design assumption:
you accept 90% — so the interaction is "scan, tick, tick, tick, correct one, done"
in under 3 minutes. The inbox nudges only when ≥3 items are pending or one is >7
days old — never one-at-a-time drip.

### 2.4 Agent lane (read-only)
Repos agents can push with zero input from you, with last-commit recency. No action,
no checkboxes. Its job is psychological: visible proof that progress happens while
you do the 20-minute session, so finishing doesn't feel like the portfolio stalling.

### 2.5 Scope review (appears monthly, or when a repo is untouched >30 days)
For each early-stage/untouched repo: ☐ Keep (say why in one line) · ☐ Snooze 90
days · ☐ Kill/archive. Repos that get no answer in two consecutive reviews are
auto-proposed as Snooze. The coach asks; you decide; nothing is archived without
your explicit tick (see Decision D4 in PLAN.md).

### 2.6 Momentum strip
Small, top or bottom: launches this month · DB sessions completed · current streak ·
hours-of-hPanel-remaining countdown (starts at ~6h, burns down visibly — finishing
the entire backlog should feel like a boss health bar, not a treadmill).

---

## 3. The Routine: cadence, triggers, anti-annoyance

**One daily Routine, fresh-session mode, push notification on completion only when
there's a real ask. Hard cap: one push per day.** Fire time: owner decision D1.

Each run, in order:
1. `harvest` — WebFetch the live-doc, diff checked state against `portfolio.json`,
   commit the updates (a ticked "besikt DB done" moves besikt's blocker to cleared).
2. `refresh-lite` — cheap staleness check (latest-commit dates via GitHub API) for
   the agent lane and to detect launches; no cloning.
3. `select` — pick today's One Thing by the priority ladder below.
4. `render` — regenerate the live-doc from `portfolio.json` + templates; republish
   to the same URL.
5. `notify` — push only if the ladder produced a real action; otherwise silent.

**Priority ladder** (first match wins):
1. **Prepped DB session pending** → nudge with the specific batch, time estimate,
   and "everything is prepped — copy-paste only."
2. **Booked session is today/overdue** → reminder framed as confirmation, not guilt.
3. **Quick-decision inbox tripped** (≥3 items or any >7 days) → batch-decision nudge.
4. **Scope review due** (monthly) → kill/keep nudge.
5. **Launch detected** → verify-and-celebrate nudge (check the live URL, tick done).
6. Nothing qualifies → **no push.** Silence is a feature.

**Anti-annoyance rules (hard):**
- Max 1 push/day, max 5/week. Sunday is always silent.
- The same nudge never repeats more than 2 consecutive days. Day 3 it *shrinks*
  (smallest sub-step, ≤5 min) instead of repeating. If the shrunk ask is also
  ignored twice, the coach switches to a question ("what's actually in the way on
  besikt?") surfaced on the dashboard, and the repo drops out of nudging for a week.
- Never two nudges about the same repo in the same week unless you interacted.
- After a completed session: next day's push is momentum-framed ("besikt is live —
  idioma is 20 min behind it"), which is the one permitted back-to-back repeat.

**Weekly deep run** (same Routine, Monday branch, or a second weekly Routine —
implementer's choice): re-audit git activity portfolio-wide, refresh percentages
and lane assignments in `portfolio.json`, recompute leverage scores, plan the
week's DB batches by Hostinger account, and queue the week's quick-decision items.

---

## 4. Leverage scoring (what "highest-leverage next" means)

`score = completion_weight + unblock_weight + tier_weight − effort_penalty − staleness_decay`

- **completion_weight**: monotone in % done, steep above 85% ("almost done" dominates).
- **unblock_weight**: +big if launching it unblocks sibling repos
  (`propia.node` → `terreno`, `app.propia`; `inmobiliaria-py` ↔ `realestateinparaguay`)
  or unblocks revenue collection (invoicing, CRM).
- **tier_weight**: infra > revenue-test > speculative. Tier is set once per repo by
  you (Decision D3), stored in `portfolio.json`, rarely touched again.
- **effort_penalty**: estimated owner-minutes for the blocker (favors 20-min DB tasks
  over multi-hour verifications).
- **staleness_decay**: mild, applied to early-stage repos only — it feeds the scope
  review, it never demotes a 95%-done repo.

The score ranks the Launch queue and picks DB batch composition (same Hostinger
account first, then score order). Exact coefficients are an implementation detail —
tune in PR-1, don't bikeshed.

---

## 5. What the repo-side code needs to be

Small, boring, testable Node scripts (no framework, no server):

| Script | Duty |
|---|---|
| `src/portfolio.js` | Load/validate/save `data/portfolio.json`; lane + blocker transitions |
| `src/score.js` | Leverage scoring + queue ordering + batch composition |
| `src/harvest.js` | Parse checked state out of fetched live-doc HTML, apply to portfolio |
| `src/render.js` | portfolio → live-doc HTML (templates in `templates/`) |
| `src/runbook.js` | Generate per-repo DB setup runbooks from stack metadata (the `nextjs-deploy-hostinger` playbook is the source of truth for steps) |
| `src/select.js` | The priority ladder + anti-annoyance state machine (nudge history lives in `data/nudges.json`) |

The Routine's prompt glues these together; the scripts hold all logic so behavior is
version-controlled and testable, and the Routine prompt stays a thin driver.
