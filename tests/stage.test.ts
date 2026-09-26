import { it,expect } from 'vitest';
import { proposeStage } from '../src/rank/stage.js';
import { localDate,weekKey,daysBetween,addDays,localDateOf } from '../src/lib/clock.js';
const now = new Date('2026-09-26T12:00:00Z');
it('raises on evidence by at most one rung and never lowers automatically',() => {
  expect(proposeStage('building',{},now)).toBeNull();
  expect(proposeStage('building',{status:200},now)?.stage).toBe('deployed');
  expect(proposeStage('deployed',{status:200,in_yaml:true,confidence:'high',title:'Propia homes'},now)?.stage).toBe('live');
  expect(proposeStage('deployed',{status:200,in_yaml:true,confidence:'medium',title:'Propia'},now)?.stage).toBe('live');
  expect(proposeStage('deployed',{status:200,in_yaml:true,confidence:'low',title:'Propia'},now)).toBeNull();
  expect(proposeStage('building',{status:200,in_yaml:true,confidence:'high',title:'Propia homes'},now)?.stage).toBe('live');
  expect(proposeStage('deployed',{status:200,in_yaml:true,confidence:'high',title:'Hostinger parking'},now)).toBeNull();
  expect(proposeStage('live',{status:503},now)).toBeNull();
  expect(proposeStage('live',{revenue_dates:['2026-09-01']},now)?.stage).toBe('earning');
  expect(proposeStage('live',{revenue_dates:['2025-01-01','2027-01-01']},now)).toBeNull();
  expect(proposeStage('planned',{revenue_dates:['2026-09-01']},now)?.stage).toBe('earning');
  expect(proposeStage('paused',{status:200},now)).toBeNull(); expect(proposeStage('killed',{status:200},now)).toBeNull();
  expect(proposeStage('earning',{status:200},now,'idea')?.stage).toBe('idea');
});
it('uses the owner day rather than the UTC day',() => {
  expect(localDate(new Date('2026-09-26T01:00:00Z'))).toBe('2026-09-25');
  expect(weekKey('2026-09-27')).toBe('2026-09-21'); expect(daysBetween('2026-09-26','2026-09-24')).toBe(2);
  expect(addDays('2026-09-30',1)).toBe('2026-10-01'); expect(localDateOf('2026-09-26','America/Asuncion')).toBe('2026-09-26');
});
