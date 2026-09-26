import { activeStages, type Stage } from '../portfolio/schema.js';
export interface StageEvidence { status?: number; in_yaml?: boolean; confidence?: 'high' | 'medium' | 'low'; title?: string; revenue_dates?: string[] }
export function proposeStage(current: Stage, evidence: StageEvidence, now: Date, manual?: Stage): { stage: Stage; evidence: string } | null {
  if (manual !== undefined) return manual === current ? null : { stage: manual, evidence: 'Manual choice' };
  if (current === 'paused' || current === 'killed') return null;
  let target: typeof activeStages[number] | undefined, reason = '';
  if (evidence.status && evidence.status >= 200 && evidence.status < 300) {
    target = 'deployed'; reason = 'Domain answers 2xx';
    if (evidence.in_yaml && evidence.confidence === 'high' && evidence.title?.trim() && !/hostinger|parking|parked|coming soon|default page|welcome to nginx/i.test(evidence.title)) {
      target = 'live'; reason = 'Confirmed domain answers 2xx with a real title';
    }
  }
  if (evidence.revenue_dates?.some(d => { const age = now.getTime() - Date.parse(d); return age >= 0 && age <= 60 * 86_400_000; })) { target = 'earning'; reason = 'Revenue in the last 60 days'; }
  if (!target || activeStages.indexOf(target) <= activeStages.indexOf(current)) return null;
  const next = activeStages[activeStages.indexOf(current) + 1];
  return { stage: next, evidence: next === target ? reason : `${reason} (capped at one stage per run)` };
}
