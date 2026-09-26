import { z } from 'zod';
export const activeStages = ['idea', 'planned', 'building', 'deployed', 'live', 'earning'] as const;
export const stages = [...activeStages, 'paused', 'killed'] as const;
export type Stage = typeof stages[number];
const name = z.string().trim().min(1);
export const domainSchema = z.object({
  host: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i),
  hosting: name.optional(), app: z.enum(['node', 'php', 'static']).optional(), crm_site: name.optional(),
  source: name.optional(), confidence: z.enum(['high', 'medium', 'low']).optional(),
}).strict();
export const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i), name,
  stage: z.enum(stages), stage_before: z.enum(activeStages).optional(), status_note: name.optional(),
  market: z.enum(['PY', 'SE', 'global', 'unknown']).default('unknown'), kind: z.enum(['leadgen', 'portal', 'saas', 'consumer', 'content', 'infra', 'client', 'unknown']).default('unknown'),
  money: z.object({ model: name, weight: z.number().int().min(1).max(5) }).strict(),
  repos: z.array(name), domains: z.array(domainSchema), notes: z.string().default(''),
}).strict().superRefine((p, ctx) => {
  if (p.stage === 'paused' || p.stage === 'killed') {
    if (!p.stage_before) ctx.addIssue({ code: 'custom', path: ['stage'], message: 'paused and killed require stage_before' });
    if (!p.status_note) ctx.addIssue({ code: 'custom', path: ['stage'], message: 'paused and killed require status_note' });
  }
});
export const portfolioSchema = z.object({
  version: z.literal(1), owner_tz: name.refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  limits: z.object({ hostinger_process_limit: z.number().int().positive() }).strict(),
  hosting_accounts: z.array(z.object({ id: name, label: name, process_limit: z.number().int().positive().optional(),
    ssh: z.object({ host: name, port: z.number().int().min(1).max(65535), user: name, key: name }).strict().optional(),
  }).strict()), projects: z.array(projectSchema),
  unassigned: z.object({ repos: z.array(name), domains: z.array(domainSchema.extend({ suggested_project: name.optional() })) }).strict(),
  local_only: z.array(z.object({ path: name, name }).strict()).optional(),
}).strict().superRefine((p, ctx) => {
  const ids = new Set<string>(), repos = new Set<string>(), hosts = new Set<string>(), accounts = new Set<string>();
  const duplicate = (set: Set<string>, value: string, path: (string | number)[]) => {
    if (set.has(value)) ctx.addIssue({ code: 'custom', path, message: 'Duplicate identity' });
    set.add(value);
  };
  p.hosting_accounts.forEach((a, i) => duplicate(accounts, a.id, ['hosting_accounts', i, 'id']));
  p.projects.forEach((project, i) => {
    duplicate(ids, project.id, ['projects', i, 'id']);
    project.repos.forEach((r, j) => duplicate(repos, r, ['projects', i, 'repos', j]));
    project.domains.forEach((d, j) => {
      duplicate(hosts, d.host, ['projects', i, 'domains', j, 'host']);
      if (d.hosting && !accounts.has(d.hosting)) ctx.addIssue({ code: 'custom', path: ['projects', i, 'domains', j, 'hosting'], message: 'Unknown hosting account' });
    });
  });
  p.unassigned.repos.forEach((r, i) => duplicate(repos, r, ['unassigned', 'repos', i]));
  p.unassigned.domains.forEach((d, i) => duplicate(hosts, d.host, ['unassigned', 'domains', i, 'host']));
});
export type Portfolio = z.infer<typeof portfolioSchema>;
export type Project = z.infer<typeof projectSchema>;
