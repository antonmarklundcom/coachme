/**
 * The chat panel is advice, not action.
 *
 * plan.md §5 O2 requires this endpoint to be read-only, and the O2 prompt makes
 * proving it an exit criterion rather than polish. The adversarial run happens
 * against a live database and a hostile stand-in model (recorded in plan.md §9);
 * what is pinned HERE is the structural half — the properties that make the
 * database untouchable no matter what the model replies, so a later phase
 * cannot quietly undo them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_QUESTION_LENGTH } from '../lib/chat';
import { COACH_MODEL } from '../lib/anthropic';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const CHAT_PATH = ['app/api/chat/route.ts', 'lib/chat.ts', 'lib/anthropic.ts'];
const chatSource = CHAT_PATH.map(read).join('\n');
const queries = read('lib/queries.ts');

/** Every function in the service layer that can change state. */
const WRITE_FUNCTIONS = [
  'updateRepo',
  'clearBlocker',
  'upsertStack',
  'recordScanEvent',
  'resolveVerifyItem',
  'recordNudge',
  'setNudgeOutcome',
  'patchSessionState',
  'savePushSubscription',
  'deletePushSubscription',
];

/** One exported function's source, up to the next top-level export. */
function bodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`));
  expect(start, `lib/queries.ts should export ${name}`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\nexport\s/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('the chat endpoint cannot write', () => {
  it('reaches no write function in the service layer', () => {
    for (const fn of WRITE_FUNCTIONS) {
      expect(chatSource, `${fn} must not be reachable from the chat path`).not.toMatch(
        new RegExp(`\\b${fn}\\b`)
      );
    }
  });

  it('reads only through SELECT-only query functions', () => {
    for (const fn of ['getRepoById', 'getRecentScanEvents', 'getStack']) {
      expect(bodyOf(queries, fn)).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    }
  });

  it('never declares tools, so the model has no mechanism to act', () => {
    // This is the load-bearing one: with no tools, the worst a hostile or
    // confused reply can do is *claim* to have changed something.
    expect(read('lib/anthropic.ts')).not.toMatch(/\btools\s*:/);
    expect(chatSource).not.toMatch(/\btool_choice\b/);
  });

  it('never parses the reply into anything but a string', () => {
    expect(read('lib/chat.ts')).not.toMatch(/JSON\.parse\s*\(\s*(answer|text|reply)/);
  });

  it('tells the model plainly that it is read-only', () => {
    const chat = read('lib/chat.ts');
    expect(chat).toMatch(/read-only and you have no tools/);
    expect(chat).toMatch(/Never claim to have made a change/);
  });

  it('issues SQL from nowhere but the service layer', () => {
    for (const file of CHAT_PATH) {
      expect(read(file), `${file} must not contain SQL`).not.toMatch(/\bFROM\s+(repos|nudges|settings)\b/i);
    }
  });
});

describe('the chat endpoint’s guardrails', () => {
  it('caps how long a question may be', () => {
    expect(MAX_QUESTION_LENGTH).toBe(1000);
    expect(read('app/api/chat/route.ts')).toMatch(/MAX_QUESTION_LENGTH/);
  });

  it('rate-limits, so a runaway client cannot run up an API bill', () => {
    const route = read('app/api/chat/route.ts');
    expect(route).toMatch(/MAX_PER_WINDOW/);
    expect(route).toMatch(/status: 429/);
  });

  it('is not in the proxy’s open paths — it stays behind the owner gate', () => {
    const proxy = read('proxy.ts');
    // The array literal itself, not the surrounding prose — the doc comment for
    // CLOSED_WITHOUT_SECRET quite reasonably mentions /api/chat.
    const openPaths = /const OPEN_PATHS = \[([\s\S]*?)\];/.exec(proxy)?.[1] ?? '';
    expect(openPaths).toBeTruthy();
    expect(openPaths).not.toMatch(/api\/chat/);
    // The cron routes, by contrast, must be open to the cookie check.
    expect(openPaths).toMatch(/api\/nudge/);
    expect(openPaths).toMatch(/api\/scan/);
  });

  it('refuses rather than opens when there is no OWNER_SECRET to enforce', () => {
    // The "no secret means no gate, or the app locks shut" rule is about pages
    // a human can recover from. An endpoint that writes rows or spends money
    // has no such argument: a forgotten env var must cost a feature, not hand
    // the internet a writable endpoint and an Anthropic bill.
    const proxy = read('proxy.ts');
    const closed = /const CLOSED_WITHOUT_SECRET = \[([^\]]*)\]/.exec(proxy)?.[1] ?? '';
    expect(closed).toMatch(/api\/chat/);
    expect(closed).toMatch(/api\/push\/subscribe/);
    expect(proxy).toMatch(/status: 503/);
  });
});

describe('model policy (plan.md §4.8, fable-cost-guardrail)', () => {
  it('uses Sonnet for both the scan and the chat panel', () => {
    expect(COACH_MODEL).toBe('claude-sonnet-5');
  });

  it('names Fable nowhere in the app', () => {
    for (const file of [...CHAT_PATH, 'lib/scan/classify.ts', 'lib/nudge/run.ts', 'lib/push.ts']) {
      expect(read(file).toLowerCase()).not.toMatch(/claude-fable|claude-mythos/);
    }
  });
});
