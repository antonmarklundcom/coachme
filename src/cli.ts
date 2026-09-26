#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb,migrate } from './db/index.js';
import { run } from './lib/exec.js';
import { log } from './lib/log.js';
import { generatePortfolioFiles } from './portfolio/generate.js';
import { loadPortfolioFile } from './portfolio/load.js';
import { syncPortfolio } from './portfolio/sync.js';
import { collectorRegistry } from './collectors/registry.js';
import { runCollector } from './collectors/runner.js';
import { freshness } from './collectors/freshness.js';
import { addInbox } from './web/today.js';
import { buildToday } from './today/service.js';
import { setTaskStatus } from './tasks/store.js';
import { alertSentence } from './alerts/index.js';
import { suggestEarning } from './money/index.js';
import { generateReview, sections } from './review/weekly.js';
import { createTelegram } from './notify/telegram.js';
import { sendReview, todayText } from './notify/rhythm.js';
import { backupDb } from './lib/backup.js';
async function main() {
  const root = fileURLToPath(new URL('../',import.meta.url));
  const config = loadConfig(root), db = openDb(resolve(root,'data/coach.db'));
  try {
    migrate(db);
    const collectors = collectorRegistry(config,root);
    const [command,arg] = process.argv.slice(2), path = resolve(root,'portfolio.yaml');
    if (command === 'portfolio' && arg === 'generate') {
      await generatePortfolioFiles(config,run,root); syncPortfolio(db,loadPortfolioFile(path)); log.info('Portfolio generated');
    } else if (command === 'collect') {
      if (existsSync(path)) syncPortfolio(db,loadPortfolioFile(path));
      const selected = arg === 'all' ? collectors : collectors.filter(c => c.name === arg);
      if (!selected.length) throw new Error(`Choose ${collectors.map(c => c.name).join(', ')}, or all`);
      for (const collector of selected) if (!await runCollector(collector,{db,config,exec:run,now:() => new Date(),log})) process.exitCode = 1;
    } else if (command === 'status') {
      log.info('Collector | Last success | Status | Last error');
      for (const f of freshness(db,collectors)) log.info(`${f.collector} | ${f.last_ok ?? 'never'} | ${f.stale ? `stale since ${f.stale_since ?? 'never'}` : 'fresh'} | ${f.last_error ?? '-'}`);
    } else if (command === 'add') {
      const text = process.argv.slice(3).join(' ').trim();
      if (!text) throw new Error('Usage: coach add TEXT');
      addInbox(db,text,'cli',new Date()); log.info('Added to inbox.');
    } else if (command === 'today') {
      const now = () => new Date();
      const alerts = db.prepare("SELECT kind,subject,severity FROM alerts WHERE closed_at IS NULL AND severity='red'").all() as {kind:string;subject:string;severity:string}[];
      for (const a of alerts) log.info(`BROKEN  ${alertSentence(db,a,now())}`);
      const view = await buildToday({db,now,githubOwner:config.github_owner,timeZone:config.owner_tz,ai:{db,config:config.ai,timeZone:config.owner_tz,now,log}});
      if (!view.actions.length) log.info('No open tasks.');
      view.actions.forEach((a,i) => log.info(`${i + 1}. [${a.task.id}] ${a.task.title}
   ${a.project?.name ?? a.task.repo ?? 'no project'} · ${a.reason}`));
    } else if (command === 'revenue' && arg === 'add') {
      // coach revenue add PROJECT AMOUNT CURRENCY [none|monthly|yearly] [CLIENT…]
      const [project, amountText, currencyText, maybeRecurring, ...rest] = process.argv.slice(4);
      const amount = Number(amountText), currency = (currencyText ?? '').toUpperCase();
      const recurring = ['none','monthly','yearly'].includes(maybeRecurring ?? '') ? maybeRecurring : 'none';
      const client = (['none','monthly','yearly'].includes(maybeRecurring ?? '') ? rest : [maybeRecurring, ...rest]).filter(Boolean).join(' ') || null;
      if (!project || !Number.isFinite(amount) || amount < 0 || !['PYG','SEK','USD','EUR'].includes(currency)) throw new Error('Usage: coach revenue add PROJECT AMOUNT PYG|SEK|USD|EUR [none|monthly|yearly] [CLIENT]');
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(project)) throw new Error(`Unknown project ${project} (use the id from portfolio.yaml)`);
      const now = new Date(), date = new Intl.DateTimeFormat('en-CA',{timeZone:config.owner_tz}).format(now);
      db.prepare('INSERT INTO revenue(project_id,client,amount,currency,recurring,date,created_at) VALUES (?,?,?,?,?,?,?)').run(project,client,amount,currency,recurring,date,now.toISOString());
      const suggested = suggestEarning(db,project,now);
      log.info(`Recorded ${amount} ${currency} for ${project}${suggested ? ` (stage suggestion: ${suggested})` : ''}.`);
    } else if (command === 'task' && (arg === 'done' || arg === 'drop')) {
      const id = Number(process.argv[4]);
      if (!Number.isInteger(id) || !setTaskStatus(db,id,arg === 'done' ? 'done' : 'dropped',new Date())) throw new Error('Usage: coach task done|drop ID (see coach today)');
      log.info(`Task ${id} marked ${arg === 'done' ? 'done' : 'dropped'}.`);
    } else if (command === 'review') {
      // coach review [--send]: write this week's review now; --send also sends it to Telegram.
      const now = () => new Date(), ai = {db,config:config.ai,timeZone:config.owner_tz,now,log};
      const review = await generateReview(db,ai,now(),config.owner_tz);
      log.info(review.headline);
      for (const s of sections(JSON.parse(review.facts))) log.info(`${s.title}: ${s.lines.length ? `\n  ${s.lines.join('\n  ')}` : 'none'}`);
      if (process.argv.includes('--send')) { const send = telegramSend(); await sendReview(db,send,review,now(),`http://${config.host}:${config.port}/review`); log.info('Sent to Telegram.'); }
    } else if (command === 'backup') {
      // coach backup: copy data/coach.db to data/backups/coach-DATE.db now (the server also does this daily).
      const { path, removed } = await backupDb(db,resolve(root,'data/backups'),new Date(),config.owner_tz);
      log.info(`Backed up to ${path}${removed.length ? `; removed ${removed.length} older` : ''}.`);
    } else if (command === 'push') {
      // coach push: send today's message to Telegram now (red alerts plus the 3 actions).
      const now = () => new Date(), ai = {db,config:config.ai,timeZone:config.owner_tz,now,log};
      const text = await todayText({db,now,today:{db,ai,githubOwner:config.github_owner,timeZone:config.owner_tz,now}});
      if (!text) log.info('Nothing to send: no red alerts and no open tasks.');
      else { await telegramSend()(text); log.info('Sent to Telegram.'); }
    } else throw new Error('Usage: coach portfolio generate | coach collect NAME|all | coach status | coach add TEXT | coach today | coach task done|drop ID | coach revenue add PROJECT AMOUNT CURRENCY [recurring] [CLIENT] | coach review [--send] | coach push | coach backup');
  } finally { db.close(); }
}
function telegramSend() {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.local');
  const telegram = createTelegram(token);
  return (html: string) => telegram.send(chatId,html);
}
main().catch(error => { log.error(String(error)); process.exitCode = 1; });
