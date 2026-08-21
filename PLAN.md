# PLAN — Portfolio Focus Coach (`coachme`)

Authored by Fable 5. Build model: Sonnet/Opus, PR by PR. Read `DESIGN.md` first —
it holds the coaching logic this plan implements. Delivery architecture is settled
(repo + live-doc Artifact + Routine); do not redesign it.

---

## ⚠️ Business decisions needed from the owner

Answer these on the dashboard once PR-3 ships, or in any session before then.
Only **D1–D2 block a PR**; the rest have safe defaults the build proceeds with.

| # | Decision | Needed for | Default until answered |
|---|---|---|---|
| **D1** | Daily nudge time **and your timezone** (Sweden? Paraguay? split?) | PR-4 (Routine cron is UTC) | 08:00 Europe/Stockholm |
| **D2** | Which Hostinger account (of the 3) hosts which of the ~12 DB-blocked repos | PR-2 batching (which repos share one hPanel sitting) | Batch by market (SE vs PY) as a proxy |
| **D3** | Confirm/correct proposed tiers in `data/portfolio.json` (`infra` / `revenue` / `experiment`) — biggest ranking lever | PR-1 scoring | Proposals as seeded: vendercrm, facturar, qr, propia.node, contabilidad = infra |
| **D4** | May the coach *propose* archiving repos in scope reviews, and does "kill" mean GitHub-archive or just a `killed` flag? | PR-6 | Propose yes; execution always requires your explicit tick; "kill" = flag only |
| **D5** | Weekly deep-audit depth: GitHub-API-only (cheap, %-estimates drift slowly) or clone-and-read (accurate, heavier)? | PR-5 | API-only, with a monthly clone-and-read pass |
| **D6** | Classify the 12 `owner-setup-unclassified` blockers (gruas, embarazo.2.1, propia.node, vendercrm, muebleria, Carpinteria.html, byggmedia, carpinteria-com-py, aireceptionisterna, contenido, sitiosweb, asado-com-py, brfinspektion, tasacion, ciberseguridad) — one line each: what exactly is the next owner step? | Queue accuracy | They rank by % only until classified; PR-3 puts this on the dashboard as a quick-decision batch |

---

## PR sequence

### PR-1 — State of record + scoring  *(agent-executable, no owner input)*
- `src/portfolio.js`: load/validate/save `data/portfolio.json`; lane and blocker
  transition helpers (e.g. `clearBlocker('besikt','db-setup')` moves it toward launched).
- `src/score.js`: leverage score per `DESIGN.md §4`; queue ordering; DB-batch
  composition (group by Hostinger account per D2, else market proxy).
- `data/nudges.json`: nudge-history schema (repo, nudge type, date, outcome) for the
  anti-annoyance state machine.
- Unit tests for scoring monotonicity (95% infra repo must outrank any 0% repo under
  every sane coefficient choice) and batch grouping.
- **Done when:** `node src/score.js` prints the ranked launch queue and the first
  proposed DB batch from the seeded data.

### PR-2 — Runbook generator  *(agent-executable; placeholders only)*
- `src/runbook.js` + `templates/runbook-hostinger-mysql.md`: per-repo runbook with
  exact DB name, user, Remote-MySQL/IP-whitelist step, env var strings with
  `<PASTE_PASSWORD>` placeholders, migration/seed commands in order, one-line verify.
  Steps follow the `nextjs-deploy-hostinger` playbook (it already contains the
  verified Hostinger pitfalls: Remote MySQL, tsx .env loading, changed-password crash).
- Generate `runbooks/<repo>.md` for the 12 DB-blocked repos by reading each repo's
  stack (drizzle config, `.env.example`, migration scripts). Requires read access to
  those repos via `add_repo` — agent handles it; nothing needed from owner.
- **Hard rule:** no real credentials in this repo or on the live-doc, ever.
- **Done when:** `runbooks/besikt.md` is a copy-paste session a stranger could run.

### PR-3 — Live-doc dashboard v1  *(agent builds; owner verifies round-trip, ~2 min)*
- `src/render.js` + `templates/dashboard.html`: portfolio → the six sections of
  `DESIGN.md §2`. Declares `capabilities: {artifact: {}}` (live-doc). Phone-first,
  theme-aware, checkboxes and short text fields only.
- `src/harvest.js`: parse checked state from fetched live-doc HTML back into
  `portfolio.json`. Round-trip test: render → simulate ticks → harvest → diff.
- Publish the artifact; record its permanent URL in `data/config.json`.
- Includes the D6 classification batch and D1–D5 as the first quick-decisions inbox.
- **Owner-only:** open the URL on your phone, tick one test box, confirm next
  session reads it back. That's the whole acceptance test.

### PR-4 — Daily Routine + nudge engine  *(agent builds; owner confirms D1)*
- `src/select.js`: priority ladder + anti-annoyance state machine from
  `DESIGN.md §3`, driven by `data/nudges.json`. Unit-test the caps hard: never >1
  push/day, >5/week; same nudge never 3 days running; day-3 shrink; Sunday silence.
- `ROUTINE.md`: the exact prompt the Routine fires with — thin driver that runs
  harvest → refresh-lite → select → render → notify, committing state changes.
- Create the Routine (fresh-session mode, push notification on) at D1's time.
- **Done when:** a manually fired run produces a correct nudge from seeded state and
  a second immediate run correctly stays silent.

### PR-5 — Weekly deep refresh  *(agent-executable; D5 sets depth)*
- Monday branch in the Routine (or second weekly Routine): refresh commit-recency
  and % estimates portfolio-wide, detect launches (site responds / branch merged),
  recompute scores, compose the week's DB batches, queue the week's decisions.
- Drift guard: if refreshed state contradicts a human tick (repo marked done but no
  deploy detected), surface a gentle verify item — never silently un-tick.

### PR-6 — Scope review + momentum  *(agent builds; owner answers per D4)*
- Monthly scope-review section generation: keep / snooze-90d / kill per stale repo,
  auto-propose snooze after two ignored reviews.
- Momentum strip: launches, sessions completed, streak, and the hPanel-hours
  burn-down bar (starts ~6h).

### Post-build — Operate
The coach is live after PR-4; PR-5/6 deepen it. First real-world milestone is not a
PR: it's **the first booked 45-minute session clearing besikt + idioma + qr** (or
whatever batch D2 puts together). The build should be sequenced so that runbooks
(PR-2) and the booking nudge (PR-4) exist before any polish does.

---

## Owner-vs-agent split, summarized

**Agent does:** everything above — code, tests, artifact publishing, Routine
creation, runbook generation (including reading the 12 target repos).

**Owner does, total ≈ 30 min across the whole build:**
1. Answer D1–D6 (one dashboard sitting, ~10 min).
2. PR-3 round-trip check (~2 min).
3. Then the actual point: sit the first prepped DB session (~45 min for the first
   batch of three, ~20 min per batch after).
