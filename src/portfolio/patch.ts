import { parseDocument } from 'yaml';
import { loadPortfolio } from './load.js';
import type { Stage } from './schema.js';
import { redact } from '../lib/redact.js';
export function setProjectStatus(yamlText: string, projectId: string, stage: Stage | 'resume', reason = ''): string {
  const portfolio = loadPortfolio(yamlText);
  const index = portfolio.projects.findIndex(p => p.id === projectId);
  if (index < 0) throw new Error('Project not found');
  const project = portfolio.projects[index];
  const doc = parseDocument(yamlText);
  const base = ['projects', index];
  if (stage === 'paused' || stage === 'killed') {
    if (!reason.trim()) throw new Error('A reason is required');
    doc.setIn([...base, 'stage_before'], project.stage === 'paused' || project.stage === 'killed' ? project.stage_before : project.stage);
    doc.setIn([...base, 'status_note'], redact(reason.trim()));
  } else {
    if (stage === 'resume') {
      if (!project.stage_before || !['paused', 'killed'].includes(project.stage)) throw new Error('Project is not paused or killed');
      stage = project.stage_before;
    }
    doc.deleteIn([...base, 'stage_before']); doc.deleteIn([...base, 'status_note']);
  }
  doc.setIn([...base, 'stage'], stage);
  const output = doc.toString(); loadPortfolio(output); return output;
}
