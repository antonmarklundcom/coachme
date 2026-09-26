import { describe,it,expect } from 'vitest';
import { loadPortfolio } from '../src/portfolio/load.js';
import { setProjectStatus } from '../src/portfolio/patch.js';
import { generatePortfolio, type GenerateInputs } from '../src/portfolio/generate.js';
import { syncPortfolio } from '../src/portfolio/sync.js';
import { fixture,testDb } from './helpers.js';
describe('portfolio YAML',() => {
  it('names the offending line for schema and syntax errors',() => {
    const text = fixture('portfolio.yaml');
    const line = text.split('\n').findIndex(l => l.includes('stage:')) + 1;
    expect(() => loadPortfolio(text.replace('stage: building','stage: invalid'))).toThrow(`line ${line}`);
    expect(() => loadPortfolio(text + '\nbroken: [\n')).toThrow(/line \d+/);
    expect(() => loadPortfolio(text.replace('weight: 4','weight: 9'))).toThrow(`line ${text.split('\n').findIndex(l => l.includes('money:')) + 1}`);
    expect(() => loadPortfolio(text.replace('stage: building','stage: paused'))).toThrow(`line ${line}`);
    const extra = text + 'unexpected: value\n';
    expect(() => loadPortfolio(extra)).toThrow(`line ${extra.split('\n').findIndex(l => l.startsWith('unexpected:')) + 1}`);
  });
  it('preserves comments and order across pause, kill and resume',() => {
    const text = fixture('portfolio.yaml');
    const paused = setProjectStatus(text,'propia','paused','Owner needs time');
    expect(paused).toContain('# Keep this comment'); expect(paused).toContain('# Owner decides');
    expect(paused.indexOf('market:')).toBeLessThan(paused.indexOf('money:'));
    expect(loadPortfolio(paused).projects[0]).toMatchObject({stage:'paused',stage_before:'building',status_note:'Owner needs time'});
    const killed = setProjectStatus(paused,'propia','killed','No longer a priority');
    expect(loadPortfolio(killed).projects[0].stage_before).toBe('building');
    const resumed = setProjectStatus(killed,'propia','resume');
    expect(loadPortfolio(resumed).projects[0].stage).toBe('building'); expect(resumed).toContain('# Keep this comment');
    expect(() => setProjectStatus(text,'propia','paused','  ')).toThrow('reason');
  });
  it('syncs identity without removing observations or suggestions',() => {
    const db = testDb(), p = loadPortfolio(fixture('portfolio.yaml'));
    syncPortfolio(db,p); syncPortfolio(db,p);
    db.prepare("INSERT INTO gh_snapshots(repo,at,open_prs,default_ci,stale_branches) VALUES ('propia.node','2026-09-26','[]','none','[]')").run();
    db.prepare("UPDATE projects SET stage_suggestion='live'").run(); syncPortfolio(db,p);
    expect(db.prepare('SELECT stage_suggestion FROM projects').get()).toEqual({stage_suggestion:'live'});
    syncPortfolio(db,{...p,projects:[],hosting_accounts:[]});
    for (const table of ['projects','repos','domains','hosting_accounts']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({n:0});
    expect(db.prepare('SELECT count(*) AS n FROM gh_snapshots').get()).toEqual({n:1});
  });
});
describe('pure generator',() => {
  const inputs = () => JSON.parse(fixture('generator.json')) as GenerateInputs;
  it('names stem-grouped projects after their project id',() => {
    const {portfolio} = generatePortfolio(inputs());
    expect(portfolio.projects.find(p => p.id === 'propia')).toMatchObject({name:'propia',repos:['app.propia','propia.node']});
    expect(portfolio.projects.find(p => p.id === 'embarazo')).toMatchObject({name:'embarazo',repos:['embarazo','embarazo.2.1']});
  });
  it('keeps clone-family projects separate and notes exactly the other three',() => {
    const input = inputs(), family = ['ecom','lenceria','productos','mascota'];
    input.domains.push(...family.map(repo => ({repo,host:'template.test',source:'CNAME',confidence:'high' as const})));
    const {portfolio} = generatePortfolio(input);
    for (const name of family) {
      const project = portfolio.projects.find(p => p.id === name)!;
      expect(project.repos).toEqual([name]);
      expect(project.notes.split('v3 (2026-08):')[0].trim()).toBe(`related: same e-commerce template as ${family.filter(other => other !== name).join(', ')}`);
    }
  });
  it('leaves low-confidence domains unassigned with a suggestion and preserves append-only edits',() => {
    const input = inputs();
    input.domains.push({repo:'propia.node',host:'guessed.com.py',source:'name pattern',confidence:'low'});
    const first = generatePortfolio(input);
    expect(first.portfolio.projects.flatMap(p => p.domains).some(d => d.host === 'guessed.com.py')).toBe(false);
    expect(first.portfolio.unassigned.domains).toContainEqual({host:'guessed.com.py',source:'name pattern',confidence:'low',suggested_project:'propia'});
    const existingYaml = fixture('portfolio.yaml');
    const updated = generatePortfolio({...input,existingYaml}).portfolioYaml;
    expect(updated.slice(0,updated.indexOf('unassigned:'))).toBe(existingYaml.slice(0,existingYaml.indexOf('unassigned:')));
    expect(loadPortfolio(updated).unassigned.domains.find(d => d.host === 'guessed.com.py')?.suggested_project).toBe('propia');
    expect(generatePortfolio({...input,existingYaml:updated}).portfolioYaml).toBe(updated);
  });
  it('uses unknown defaults and infers only attached-domain markets and infra kind',() => {
    const input = inputs();
    input.domains.push({repo:'embarazo',host:'embarazo.se',source:'CNAME',confidence:'high'},{repo:'infra',host:'infra.com.py',source:'name pattern',confidence:'low'});
    const p = generatePortfolio(input).portfolio;
    expect(p.projects.find(p => p.id === 'propia')).toMatchObject({market:'PY',kind:'unknown'});
    expect(p.projects.find(p => p.id === 'embarazo')).toMatchObject({market:'SE',kind:'unknown'});
    expect(p.projects.find(p => p.id === 'infra')).toMatchObject({market:'unknown',kind:'infra'});
    expect(p.projects.find(p => p.id === 'archive')).toMatchObject({market:'unknown',kind:'unknown'});
    const defaults = loadPortfolio(fixture('portfolio.yaml').replace('    market: PY\n','').replace('    kind: portal\n',''));
    expect(defaults.projects[0]).toMatchObject({market:'unknown',kind:'unknown'});
    const db = testDb(); syncPortfolio(db,p);
    expect(db.prepare("SELECT market,kind FROM projects WHERE id='archive'").get()).toEqual({market:'unknown',kind:'unknown'});
  });
  it('formats only existing v3 hints with date, completion and optional blocker',() => {
    const input = inputs(); input.hints = [{name:'infra',pct:75,tier:'infra',blocker:'facts'},{name:'archive',pct:100,blocker:'none'}];
    const p = generatePortfolio(input).portfolio;
    expect(p.projects.find(p => p.id === 'infra')?.notes).toBe('v3 (2026-08): 75% done, blocker facts');
    expect(p.projects.find(p => p.id === 'archive')?.notes).toBe('v3 (2026-08): 100% done');
    expect(p.projects.find(p => p.id === 'propia')?.notes).toBe('');
  });
  it('groups shared stems and domains, keeps clones separate and seeds stages and weights',() => {
    const {portfolio,portfolioYaml} = generatePortfolio(inputs());
    expect(loadPortfolio(portfolioYaml)).toEqual(portfolio);
    expect(portfolio.projects.find(p => p.id === 'propia')?.repos.sort()).toEqual(['app.propia','propia.node']);
    expect(portfolio.projects.find(p => p.id === 'embarazo')).toMatchObject({stage:'building',money:{weight:2}});
    expect(portfolio.projects.find(p => p.repos.includes('shared-one'))?.repos).toHaveLength(2);
    for (const clone of ['ecom','lenceria','productos','mascota']) expect(portfolio.projects.find(p => p.id === clone)).toMatchObject({repos:[clone],notes:expect.stringContaining('related: same e-commerce template as')});
    expect(portfolio.projects.find(p => p.id === 'archive')).toMatchObject({stage:'killed',stage_before:'planned'});
    expect(portfolio.projects.find(p => p.id === 'infra')).toMatchObject({stage:'planned',kind:'infra',money:{weight:1}});
    expect(portfolio.projects.find(p => p.id === 'ecom')?.money.weight).toBe(3);
    expect(portfolio.local_only).toEqual([{path:'fixture/offline',name:'offline'}]);
  });
  it('returns existing text unchanged when there are no discoveries',() => {
    const input = inputs(), first = generatePortfolio(input);
    const existingYaml = '# Human comment\n' + first.portfolioYaml.replace('weight: 2','weight: 5');
    expect(generatePortfolio({...input,existingYaml}).portfolioYaml).toBe(existingYaml);
  });
  it('only appends unseen unassigned items, compared as exact text',() => {
    const text = fixture('portfolio.yaml');
    const input: GenerateInputs = {repos:[{name:'propia.node',isArchived:true,pushedAt:null},{name:'app.propia',isArchived:false,pushedAt:null},{name:'new',isArchived:false,pushedAt:null}],local:[],domains:[{repo:'new',host:'new.test',source:'CNAME',confidence:'high'}],hints:[],now:'2026-09-26T00:00:00Z',existingYaml:text};
    const expected = text.replace('repos: [] # Move','repos: ["new"] # Move').replace('domains: []','domains: [{"host":"new.test","source":"CNAME","confidence":"high"}]');
    const output = generatePortfolio(input).portfolioYaml; expect(output).toBe(expected);
    expect(generatePortfolio({...input,existingYaml:output}).portfolioYaml).toBe(output);
  });
  it('appends to block sequences without rewriting human text',() => {
    const text = fixture('portfolio.yaml').replace('repos: [] # Move discoveries into projects','repos: # Move discoveries into projects\n    - known # keep').replace('domains: []','domains:\n    - host: known.test\n      confidence: low');
    const input: GenerateInputs = {repos:[{name:'new',isArchived:false,pushedAt:null}],local:[],domains:[{repo:'new',host:'new.test',source:'CNAME',confidence:'high'}],hints:[],now:'2026-09-26',existingYaml:text};
    const out = generatePortfolio(input).portfolioYaml;
    expect(out).toBe(text.replace('    - known # keep\n','    - known # keep\n    - new\n') + '    - host: new.test\n      source: CNAME\n      confidence: high\n');
  });
});
