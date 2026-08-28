'use server';

/**
 * actions.ts — every write the dashboard makes. Plain server actions, no API
 * routes: a checkbox tick or a short-text edit calls one of these directly and
 * Next revalidates `/` (plan.md §6 S1 — "there is no render→fetch→harvest
 * round-trip, there is nothing to harvest").
 *
 * Hard limit (plan.md §4.7): every write here goes through lib/queries.ts —
 * nothing in this file issues SQL, and nothing here re-decides what O1/O2's
 * service layer already decided (leverage order, the nudge ladder, drift
 * guard). This file only turns a form submission into the right query call.
 */

import { revalidatePath } from 'next/cache';
import type { Blocker } from '@/lib/domain';
import { localDate, safeTimeZone } from '@/lib/clock';
import type { SessionState } from '@/lib/nudge/ladder';
import {
  applyScopeAnswer,
  clearBlocker,
  getRepo,
  getSettings,
  patchSessionState,
  resolveDecision,
  resolveVerifyItem,
  updateRepo,
} from '@/lib/queries';

/**
 * Today's One Thing card (DESIGN.md §2.1): Booked (+ when), Done, and the
 * per-repo runbook checkboxes all live in one form, so every submit carries
 * the card's whole current state rather than a diff — patchSessionState
 * replaces these keys outright.
 */
export async function updateSessionState(formData: FormData): Promise<void> {
  const settings = await getSettings();
  const prev = (settings.session_state ?? {}) as SessionState;
  const tz = safeTimeZone(settings.owner_timezone);
  const done = formData.get('done') === 'on';

  const batchKey = String(formData.get('batch_key') ?? '').trim();

  await patchSessionState({
    batch: String(formData.get('batch') ?? prev.batch ?? ''),
    batch_key: batchKey || prev.batch_key || null,
    booked: formData.get('booked') === 'on',
    when: String(formData.get('when') ?? prev.when ?? ''),
    done,
    done_date: done ? localDate(Date.now(), tz) : (prev.done_date ?? null),
  });
  revalidatePath('/');
}

/**
 * Launch queue tick (DESIGN.md §2.2): "the moment its blocker is actually
 * cleared". One-way, like the drift guard it feeds — there is no un-clear.
 */
export async function clearRepoBlocker(formData: FormData): Promise<void> {
  if (formData.get('cleared') !== 'on') return;
  const name = String(formData.get('repo'));
  const blocker = String(formData.get('blocker')) as Blocker;
  const repo = await getRepo(name);
  if (!repo || repo.blocker !== blocker) return;
  await clearBlocker(repo, blocker);
  revalidatePath('/');
}

/** Quick-decisions inbox (DESIGN.md §2.3): accept the recommendation, or correct it. */
export async function resolveDecisionAnswer(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const correction = String(formData.get('note') ?? '').trim();
  if (correction) {
    await resolveDecision(id, { status: 'corrected', answer: correction });
  } else if (formData.get('accept') === 'on') {
    await resolveDecision(id, { status: 'accepted', answer: String(formData.get('recommended') ?? '') });
  } else {
    return;
  }
  revalidatePath('/');
}

/** A drift-guard verify item (DESIGN.md §2.3): "my tick was right". */
export async function confirmVerifyItem(formData: FormData): Promise<void> {
  if (formData.get('confirmed') !== 'on') return;
  const id = Number(formData.get('id'));
  if (!Number.isFinite(id)) return;
  await resolveVerifyItem(id, 'confirmed');
  revalidatePath('/');
}

/** D6 (plan.md §7): one line — what the next owner step actually is. */
export async function classifyBlocker(formData: FormData): Promise<void> {
  const name = String(formData.get('repo'));
  const nextStep = String(formData.get('next_step') ?? '').trim();
  if (!nextStep) return;
  const repo = await getRepo(name);
  if (!repo) return;
  await updateRepo(repo.id, { next_step: nextStep });
  revalidatePath('/');
}

/** Scope review (DESIGN.md §2.5): keep, snooze 90 days, or kill — a flag here only. */
export async function applyScope(formData: FormData): Promise<void> {
  const name = String(formData.get('repo'));
  const choice = formData.get('choice');
  if (choice !== 'keep' && choice !== 'snooze' && choice !== 'kill') return;
  const repo = await getRepo(name);
  if (!repo) return;
  const note = choice === 'keep' ? String(formData.get('note') ?? '').trim() || undefined : undefined;
  await applyScopeAnswer(repo, choice, { note });
  revalidatePath('/');
}
