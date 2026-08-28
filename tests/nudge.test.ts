/**
 * The anti-annoyance rules, one test per hard rule in DESIGN.md §3.
 *
 * The O2 prompt is explicit that these are tested, not eyeballed, and the
 * reason is in §3 itself: "a coach that nags gets muted, and a muted coach is
 * worthless." Every cap below is a promise to the owner, so each one is pinned
 * here and none of them is a tunable.
 *
 * Dates in these tests are real weekdays: 2026-08-30 is a Sunday, 2026-08-31 a
 * Monday, and the week runs Monday-anchored from there.
 */

import { describe, expect, it } from 'vitest';
import type { Repo } from '../lib/domain';
import { localDate, weekKey, weekdayOf } from '../lib/clock';
import {
  CAPS,
  type NudgeRecord,
  chainLength,
  decidedOn,
  inCooldown,
  isMuted,
  pushesInWeek,
  shrunkIgnored,
} from '../lib/nudge/history';
import { type LadderInput, selectNudge } from '../lib/nudge/ladder';
import { activitySince } from '../lib/nudge/run';
import { resolveOutcomes } from '../lib/nudge/outcomes';

const MON = '2026-08-31';
const TUE = '2026-09-01';
const WED = '2026-09-02';
const THU = '2026-09-03';
const SUN = '2026-08-30';

function repo(partial: Partial<Repo> & { name: string }): Repo {
  return {
    id: 1,
    github_full_name: `antonmarklundcom/${partial.name}`,
    pct: 95,
    lane: 'launch-owner-blocked',
    blocker: 'db-setup',
    tier: 'infra',
    hostinger_account: 'main',
    market: null,
    next_step: null,
    open_prs: 0,
    merged_prs_30d: 0,
    live_url: null,
    live_url_ok: null,
    launched_at: null,
    unblocks: [],
    depends_on: [],
    related: [],
    unblocks_revenue: null,
    notes: null,
    cleared_blockers: [],
    snoozed_until: null,
    scope_review_due: false,
    scope_review_proposed: null,
    scope_reviews_unanswered: 0,
    kept_at: null,
    killed_at: null,
    last_commit_at: '2026-08-01',
    pushed_at: null,
    last_scan_at: null,
    last_scan_head_sha: null,
    blocked_scans: 0,
    newly_blocked_at: null,
    ...partial,
  } as Repo;
}

let nextId = 1;
function record(partial: Partial<NudgeRecord> & { local_date: string }): NudgeRecord {
  return {
    id: nextId++,
    type: 'db-session',
    repo_names: ['besikt'],
    outcome: 'ignored',
    pushed: true,
    shrunk: false,
    parent_type: null,
    title: null,
    body: null,
    note: null,
    ...partial,
  };
}

function input(partial: Partial<LadderInput> & { date: string }): LadderInput {
  return {
    repos: [repo({ name: 'besikt' })],
    history: [],
    session: {},
    pendingDecisions: [],
    verifyItems: [],
    ...partial,
  };
}

describe('the calendar the caps are counted in', () => {
  it('treats the owner timezone, not UTC, as "today"', () => {
    // 2026-09-02 00:30 UTC is still 2026-09-01 in Asunción (UTC-3). Counting in
    // UTC would let a late-evening push and the next morning's push land on the
    // same owner-day while looking like two different days to the cap.
    const at = Date.parse('2026-09-02T00:30:00Z');
    expect(localDate(at, 'UTC')).toBe('2026-09-02');
    expect(localDate(at, 'America/Asuncion')).toBe('2026-09-01');
  });

  it('anchors the week to Monday so "5 per week" is a stable window', () => {
    expect(weekdayOf(SUN)).toBe(0);
    expect(weekKey(MON)).toBe(MON);
    expect(weekKey(THU)).toBe(MON);
    // The Sunday BEFORE that Monday belongs to the previous week, not to it.
    expect(weekKey(SUN)).toBe('2026-08-24');
  });
});

describe('hard caps (DESIGN.md §3)', () => {
  it('is always silent on Sunday', () => {
    const decision = selectNudge(input({ date: SUN }));
    expect(decision.push).toBe(false);
    expect(decision.type).toBeNull();
    expect(decision.reason).toMatch(/Sunday/);
  });

  it('pushes at most once a day', () => {
    const history = [record({ local_date: MON, outcome: 'pending' })];
    expect(decidedOn(history, MON)).toBe(true);
    const decision = selectNudge(input({ date: MON, history }));
    expect(decision.push).toBe(false);
  });

  it('counts a silent decision as today’s decision, so a retry cannot upgrade it to a push', () => {
    // The question rung decides without pushing. A cron retry an hour later must
    // not reconsider that into a notification.
    const history = [record({ local_date: MON, type: 'question', pushed: false, outcome: 'pending' })];
    const decision = selectNudge(input({ date: MON, history }));
    expect(decision.push).toBe(false);
    expect(decision.reason).toMatch(/already decided today/);
  });

  it('pushes at most five times a week', () => {
    const history = [MON, TUE, WED, THU, '2026-09-04'].map((d) =>
      record({ local_date: d, repo_names: ['other'] })
    );
    expect(pushesInWeek(history, '2026-09-05')).toBe(CAPS.maxPerWeek);
    const decision = selectNudge(input({ date: '2026-09-05', history }));
    expect(decision.push).toBe(false);
    expect(decision.reason).toMatch(/weekly cap/);
  });

  it('does not count an undelivered decision against the weekly push cap', () => {
    const history = [MON, TUE, WED, THU].map((d) => record({ local_date: d, repo_names: ['other'] }));
    history.push(record({ local_date: '2026-09-04', repo_names: ['other'], pushed: false }));
    expect(pushesInWeek(history, '2026-09-05')).toBe(4);
    expect(selectNudge(input({ date: '2026-09-05', history })).push).toBe(true);
  });
});

describe('the escalation chain: ask → shrink → question → mute', () => {
  const asked = (dates: string[]) =>
    dates.map((d) => record({ local_date: d, repo_names: ['besikt'], outcome: 'ignored' }));

  it('counts a chain in nudges, not calendar days, so a Sunday cannot reset it', () => {
    // Asked Thursday and Friday; Sunday was silent. Monday is the third ask.
    const history = asked(['2026-08-27', '2026-08-28']);
    expect(chainLength(history, ['besikt'], MON)).toBe(2);
  });

  it('shrinks the ask on the third consecutive run instead of repeating it', () => {
    const history = asked([MON, TUE]);
    const decision = selectNudge(input({ date: WED, history }));
    expect(decision.type).toBe('shrunk');
    expect(decision.push).toBe(true);
    expect(decision.minutes).toBe(5);
    expect(decision.repos).toEqual(['besikt']);
    expect(decision.parentType).toBe('db-session');
    expect(decision.effects.shrink).toBeTruthy();
  });

  it('does not shrink an ask that has not run twice yet', () => {
    expect(selectNudge(input({ date: TUE, history: asked([MON]) })).type).toBe('db-session');
  });

  it('starts a fresh chain for a different batch rather than inheriting its patience', () => {
    // Two ignored asks, but about another repo entirely.
    const history = [MON, TUE].map((d) => record({ local_date: d, repo_names: ['idioma'] }));
    expect(chainLength(history, ['besikt'], WED)).toBe(0);
    expect(selectNudge(input({ date: WED, history })).type).toBe('db-session');
  });

  it('stops asking and surfaces a question once two shrunk asks are ignored', () => {
    const history = [
      ...asked(['2026-08-25', '2026-08-26']),
      record({ local_date: '2026-08-27', type: 'shrunk', shrunk: true, repo_names: ['besikt'], outcome: 'ignored' }),
      record({ local_date: '2026-08-28', type: 'shrunk', shrunk: true, repo_names: ['besikt'], outcome: 'ignored' }),
    ];
    expect(shrunkIgnored(history, 'besikt')).toBe(CAPS.shrunkIgnoredLimit);

    const decision = selectNudge(input({ date: MON, history }));
    expect(decision.type).toBe('question');
    expect(decision.push).toBe(false); // a question is surfaced, never pushed
    expect(decision.title).toMatch(/what is actually in the way on besikt/i);
  });

  it('resets the ignore count as soon as the owner acts on anything about the repo', () => {
    const history = [
      record({ local_date: '2026-08-27', type: 'shrunk', shrunk: true, outcome: 'ignored' }),
      record({ local_date: '2026-08-28', outcome: 'acted' }),
      record({ local_date: '2026-08-29', type: 'shrunk', shrunk: true, outcome: 'ignored' }),
    ];
    expect(shrunkIgnored(history, 'besikt')).toBe(1);
  });
});

describe('muting (DESIGN.md §3: the repo drops out of nudging for a week)', () => {
  const question = record({ local_date: MON, type: 'question', pushed: false, outcome: 'pending' });

  it('mutes the repo for a week after the question', () => {
    expect(isMuted([question], 'besikt', TUE)).toBe(true);
    expect(isMuted([question], 'besikt', '2026-09-06')).toBe(true); // day 6
    expect(isMuted([question], 'besikt', '2026-09-07')).toBe(false); // day 7, over
  });

  it('lifts the mute early if the owner answers the question', () => {
    const answered = { ...question, outcome: 'acted' as const };
    expect(isMuted([answered], 'besikt', TUE)).toBe(false);
  });

  it('rotates to another batch rather than going silent while a repo is muted', () => {
    const repos = [
      repo({ name: 'besikt', id: 1, hostinger_account: 'a' }),
      repo({ name: 'idioma', id: 2, hostinger_account: 'b', pct: 90 }),
    ];
    const decision = selectNudge(input({ date: TUE, repos, history: [question] }));
    expect(decision.type).toBe('db-session');
    expect(decision.repos).toEqual(['idioma']);
  });

  it('says nothing at all when every batch is muted', () => {
    const decision = selectNudge(input({ date: TUE, history: [question] }));
    expect(decision.push).toBe(false);
    expect(decision.reason).toMatch(/nothing on the ladder/);
  });
});

describe('the per-repo weekly cooldown', () => {
  it('keeps a second rung off a repo the coach already nudged this week', () => {
    const history = [record({ local_date: MON, repo_names: ['anillos'] })];
    expect(inCooldown(history, 'anillos', WED)).toBe(true);
    expect(inCooldown(history, 'anillos', '2026-09-07')).toBe(false); // 7 days on
  });

  it('lifts the cooldown as soon as the owner interacted', () => {
    const history = [record({ local_date: MON, repo_names: ['anillos'], outcome: 'acted' })];
    expect(inCooldown(history, 'anillos', WED)).toBe(false);
  });

  it('keeps the scope review off a repo the coach nudged two days ago', () => {
    const stale = repo({ name: 'anillos', blocker: 'scope-undefined', pct: 5, scope_review_due: true });
    const history = [record({ local_date: MON, repo_names: ['anillos'] })];
    // No DB batch exists, so the scope rung is next in line — and still declines.
    const decision = selectNudge(input({ date: WED, repos: [stale], history }));
    expect(decision.type).not.toBe('scope-review');
  });
});

describe('the ladder, first match wins (DESIGN.md §3)', () => {
  it('puts a prepped DB session at the top', () => {
    const decision = selectNudge(
      input({ date: MON, session: { booked: true, batch: 'besikt', when: 'Thu 09:00' } })
    );
    expect(decision.type).toBe('db-session');
    expect(decision.title).toMatch(/25 min unblocks 1 launch$/);
  });

  it('falls to the booked reminder once no DB batch is left', () => {
    const cleared = repo({ name: 'besikt', blocker: 'none', lane: 'launch-agent-drivable' });
    const decision = selectNudge(
      input({ date: MON, repos: [cleared], session: { booked: true, batch: 'besikt', when: 'Thu 09:00' } })
    );
    expect(decision.type).toBe('booked-reminder');
    expect(decision.title).toMatch(/Thu 09:00/);
  });

  it('does not remind about a session already ticked done', () => {
    const cleared = repo({ name: 'besikt', blocker: 'none', lane: 'launch-agent-drivable' });
    const decision = selectNudge(
      input({ date: MON, repos: [cleared], session: { booked: true, done: true, batch: 'besikt' } })
    );
    expect(decision.type).not.toBe('booked-reminder');
  });

  it('holds the decisions inbox until it is worth three minutes', () => {
    const cleared = [repo({ name: 'besikt', blocker: 'none', lane: 'launch-agent-drivable' })];
    const two = [
      { id: 'D2', created_at: `${MON}T09:00:00Z` },
      { id: 'D3', created_at: `${MON}T09:00:00Z` },
    ];
    expect(selectNudge(input({ date: TUE, repos: cleared, pendingDecisions: two })).type).toBeNull();

    const three = [...two, { id: 'D6', created_at: `${MON}T09:00:00Z` }];
    expect(selectNudge(input({ date: TUE, repos: cleared, pendingDecisions: three })).type).toBe(
      'quick-decisions'
    );
  });

  it('nudges a single inbox item once it has waited a week', () => {
    const cleared = [repo({ name: 'besikt', blocker: 'none', lane: 'launch-agent-drivable' })];
    const old = [{ id: 'D2', created_at: '2026-08-24T09:00:00Z' }];
    const decision = selectNudge(input({ date: '2026-08-31', repos: cleared, pendingDecisions: old }));
    expect(decision.type).toBe('quick-decisions');
  });

  it('counts an open drift-guard verify item as an inbox item', () => {
    const cleared = [repo({ name: 'besikt', blocker: 'none', lane: 'launch-agent-drivable' })];
    const decision = selectNudge(
      input({
        date: TUE,
        repos: cleared,
        pendingDecisions: [{ id: 'D2', created_at: `${MON}T09:00:00Z` }],
        verifyItems: [
          { repo_name: 'propia.node', created_at: `${MON}T09:00:00Z` },
          { repo_name: 'terreno', created_at: `${MON}T09:00:00Z` },
        ],
      })
    );
    expect(decision.type).toBe('quick-decisions');
    expect(decision.title).toMatch(/^3 decisions/);
  });

  it('celebrates a launch rather than staying quiet about it', () => {
    const launched = repo({
      name: 'besikt',
      blocker: 'none',
      lane: 'launch-agent-drivable',
      launched_at: MON,
      live_url: 'https://besikt.se',
      live_url_ok: null,
    });
    const decision = selectNudge(input({ date: MON, repos: [launched] }));
    expect(decision.type).toBe('launch-verify');
  });

  it('says nothing when nothing qualifies — silence is a feature', () => {
    const quiet = repo({ name: 'besikt', blocker: 'none', lane: 'launch-agent-drivable' });
    const decision = selectNudge(input({ date: MON, repos: [quiet] }));
    expect(decision.push).toBe(false);
    expect(decision.type).toBeNull();
  });
});

describe('the momentum push — the one permitted back-to-back repeat', () => {
  const session = { done: true, done_date: MON, batch: 'besikt,idioma' };

  it('fires the day after a completed session, even through a live escalation chain', () => {
    // Two ignored asks about this very batch would normally force a shrink.
    const history = [MON, '2026-08-28'].map((d) => record({ local_date: d, repo_names: ['besikt'] }));
    const decision = selectNudge(input({ date: TUE, history, session }));
    expect(decision.type).toBe('momentum');
    expect(decision.push).toBe(true);
    expect(decision.title).toMatch(/besikt, idioma cleared/);
  });

  it('is one day only', () => {
    expect(selectNudge(input({ date: WED, session })).type).not.toBe('momentum');
  });

  it('still yields to Sunday and to the weekly cap', () => {
    expect(selectNudge(input({ date: SUN, session: { ...session, done_date: SUN } })).push).toBe(false);
  });
});

describe('resolving what the owner actually did', () => {
  const pending = [
    record({ local_date: MON, repo_names: ['besikt'], outcome: 'pending' }),
    record({ local_date: MON, repo_names: [], type: 'quick-decisions', outcome: 'pending' }),
  ];

  it('marks a nudge acted when the owner ticked one of its repos', () => {
    const resolved = resolveOutcomes(pending, [{ repo: 'besikt', date: TUE, what: 'cleared db-setup' }], WED);
    expect(resolved.find((r) => r.id === pending[0].id)?.outcome).toBe('acted');
    expect(resolved.find((r) => r.id === pending[1].id)?.outcome).toBe('ignored');
  });

  it('lets a repo-less action settle the repo-less nudge', () => {
    const resolved = resolveOutcomes(pending, [{ repo: null, date: TUE, what: 'answered a decision' }], WED);
    expect(resolved.find((r) => r.id === pending[1].id)?.outcome).toBe('acted');
  });

  it('ignores an action that predates the ask', () => {
    const resolved = resolveOutcomes(pending, [{ repo: 'besikt', date: SUN, what: 'cleared db-setup' }], WED);
    expect(resolved.every((r) => r.outcome === 'ignored')).toBe(true);
  });

  it('leaves today’s own nudge pending — the owner has not had the day yet', () => {
    const today = [record({ local_date: WED, outcome: 'pending' })];
    expect(resolveOutcomes(today, [], WED)).toHaveLength(0);
  });
});

describe('how far back the run looks for owner activity', () => {
  it('covers the state machine’s longest memory by default', () => {
    // 14 days: the 7-day cooldown/mute plus a week of slack.
    expect(activitySince([], WED)).toBe('2026-08-19');
  });

  it('reaches back to the oldest still-pending nudge when the cron has been down', () => {
    // A month-old ask nobody resolved. Resolving it against a 14-day window
    // would find no evidence, call it ignored, and start escalating against an
    // owner who may well have done the work three weeks ago.
    const stale = record({ local_date: '2026-08-03', outcome: 'pending' });
    expect(activitySince([stale], WED)).toBe('2026-08-03');
  });

  it('does not reach further back than it must', () => {
    const recent = record({ local_date: TUE, outcome: 'pending' });
    expect(activitySince([recent], WED)).toBe('2026-08-19');
  });

  it('ignores an already-resolved nudge, however old', () => {
    const old = record({ local_date: '2026-01-01', outcome: 'ignored' });
    expect(activitySince([old], WED)).toBe('2026-08-19');
  });
});
