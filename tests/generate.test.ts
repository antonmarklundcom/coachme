/**
 * The generator's two guarantees.
 *
 * 1. Nothing a model said reaches the database unvalidated. These items become
 *    a markdown file committed to ANOTHER repository, so the sanitizer is a
 *    trust boundary, not a formatting step.
 * 2. Every stored prompt starts with the mandatory header. The header is how
 *    the scan finds the resulting branch and PR again (Decision D-G); an item
 *    without one is work this app can dispatch and then lose.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ITEMS, parsePlanText, sanitizePlan } from '../lib/generate/sanitize';
import { hasHeader, promptHeader, withHeader, type HeaderContext } from '../lib/generate/prompt';
import { loadTemplate, loadTemplateIndex, placeholdersIn } from '../lib/generate/templates';

const ctx = (over: Partial<HeaderContext> = {}): HeaderContext => ({
  slug: 'add-stripe-checkout',
  title: 'Add Stripe checkout',
  kind: 'agent',
  tool: 'either',
  model: 'sonnet',
  stage_target: 'sellable',
  repoFullName: 'antonmarklundcom/besikt',
  ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  slug: 'add-stripe-checkout',
  title: 'Add Stripe checkout',
  kind: 'agent',
  tool: 'claude',
  model: 'sonnet',
  stage_target: 'sellable',
  estimate_minutes: null,
  prompt_md: 'Wire up Stripe.\n\n## Exit criteria\n- a test card completes a payment',
  ...over,
});

describe('the mandatory header', () => {
  it('names the branch, the PR marker and the repo rules, in that order', () => {
    const header = promptHeader(ctx());
    expect(header).toContain('**Branch:** `coachme/add-stripe-checkout`');
    expect(header).toContain('**PR title:** `[coachme:add-stripe-checkout] Add Stripe checkout`');
    expect(header).toContain('Read `AGENTS.md` and `CLAUDE.md`');
    expect(header).toContain('open the PR and stop');
  });

  it('does not tell an owner item to open a pull request', () => {
    const header = promptHeader(ctx({ kind: 'owner', tool: 'owner', model: null, estimate_minutes: 20 }));
    expect(header).not.toContain('Branch:');
    expect(header).not.toContain('PR title:');
    expect(header).toContain('about 20 minutes');
  });

  it('is the prefix of the assembled prompt, and is not doubled', () => {
    const body = '# Add Stripe checkout\n\nWire up Stripe.';
    const prompt = withHeader(body, ctx());
    expect(hasHeader(prompt, ctx())).toBe(true);
    expect(prompt.match(/\*\*Branch:\*\*/g)).toHaveLength(1);
    expect(prompt.match(/^# Add Stripe checkout$/gm)).toHaveLength(1);
  });

  it('keeps a heading the model wrote that is not the title', () => {
    expect(withHeader('# Background\n\nsomething', ctx())).toContain('# Background');
  });
});

describe('sanitizePlan', () => {
  it('caps the plan at three items', () => {
    const plan = sanitizePlan({
      items: [1, 2, 3, 4, 5].map((n) => item({ slug: `item-${n}`, title: `Item ${n}` })),
    });
    expect(plan.items).toHaveLength(MAX_ITEMS);
  });

  it('drops an item with no prompt body rather than inventing one', () => {
    expect(sanitizePlan({ items: [item({ prompt_md: '   ' })] }).items).toEqual([]);
  });

  it('drops an item whose stage_target is not a stage', () => {
    expect(sanitizePlan({ items: [item({ stage_target: 'profitable' })] }).items).toEqual([]);
  });

  it('rescues a bad slug from the title instead of dropping good work', () => {
    const plan = sanitizePlan({ items: [item({ slug: 'Add Stripe Checkout!!' })] });
    expect(plan.items[0].slug).toBe('add-stripe-checkout');
  });

  it('never lets a model name its own expensive model', () => {
    for (const model of ['claude-fable-5', 'fable', 'opus-max', '', null]) {
      const plan = sanitizePlan({ items: [item({ model })] });
      expect(plan.items[0].model).toBe('sonnet');
    }
    expect(sanitizePlan({ items: [item({ model: 'opus' })] }).items[0].model).toBe('opus');
  });

  it('keeps kind and tool consistent: an owner item is never an agent item', () => {
    const owner = sanitizePlan({ items: [item({ kind: 'owner', tool: 'claude', model: 'opus', estimate_minutes: 15 })] });
    expect(owner.items[0]).toMatchObject({ kind: 'owner', tool: 'owner', model: null, estimate_minutes: 15 });

    const agent = sanitizePlan({ items: [item({ kind: 'agent', tool: 'owner' })] });
    expect(agent.items[0].tool).toBe('either');
  });

  it('ignores an estimate on an agent item — agent minutes are not the scarce thing', () => {
    expect(sanitizePlan({ items: [item({ estimate_minutes: 90 })] }).items[0].estimate_minutes).toBeNull();
  });

  it('skips slugs this repo already has, and duplicates within one reply', () => {
    const plan = sanitizePlan(
      { items: [item(), item({ slug: 'other-thing', title: 'Other thing' }), item()] },
      { exclude: ['other-thing'] }
    );
    expect(plan.items.map((i) => i.slug)).toEqual(['add-stripe-checkout']);
  });

  it('accepts a stage suggestion only when it is a real stage', () => {
    expect(sanitizePlan({ stage_suggestion: 'live', items: [] }).stage_suggestion).toBe('live');
    expect(sanitizePlan({ stage_suggestion: 'nearly live', items: [] }).stage_suggestion).toBeNull();
  });

  it('survives a reply that is not what was asked for at all', () => {
    expect(sanitizePlan(null).items).toEqual([]);
    expect(sanitizePlan({ items: 'sorry, I cannot help with that' }).items).toEqual([]);
    expect(sanitizePlan({ items: [null, 42, 'x'] }).items).toEqual([]);
  });

  it('finds the JSON inside a chatty or fenced reply', () => {
    expect(parsePlanText('Sure!\n```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(() => parsePlanText('I would rather not')).toThrow(/did not return JSON/);
  });
});

describe('the prompt library', () => {
  const index = loadTemplateIndex();

  it('ships the two O3 exemplars, and every entry points at a file that exists', () => {
    expect(index.map((t) => t.key)).toEqual(expect.arrayContaining(['finish-feature', 'owner-step']));
    for (const entry of index) {
      expect(existsSync(join(process.cwd(), 'templates', 'prompts', entry.file))).toBe(true);
    }
  });

  it('gives every template exit criteria and declares every placeholder it uses', () => {
    for (const entry of index) {
      const body = readFileSync(join(process.cwd(), 'templates', 'prompts', entry.file), 'utf8');
      expect(body, `${entry.key} has no exit criteria`).toContain('## Exit criteria');
      expect(placeholdersIn(body).sort()).toEqual([...entry.placeholders].sort());
    }
  });

  it('degrades to an empty library rather than throwing when there is none', () => {
    expect(loadTemplateIndex('/nonexistent/templates')).toEqual([]);
    expect(loadTemplate('finish-feature', '/nonexistent/templates')).toBeNull();
  });
});
