import { existsSync, watchFile, unwatchFile } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db/index.js';
import { log } from './lib/log.js';
import { run } from './lib/exec.js';
import { loadPortfolioFile } from './portfolio/load.js';
import { syncPortfolio } from './portfolio/sync.js';
import { collectorRegistry } from './collectors/registry.js';
import { createScheduler } from './collectors/scheduler.js';
import { createApp, listen } from './web/server.js';
import { createTelegram } from './notify/telegram.js';
import { startBot } from './notify/bot.js';
import { startRhythm, todayText } from './notify/rhythm.js';
const config = loadConfig(), db = openDb();
migrate(db);
const portfolioPath = resolve('portfolio.yaml');
const reload = () => {
  try { if (existsSync(portfolioPath)) syncPortfolio(db,loadPortfolioFile(portfolioPath)); }
  catch (error) { log.error(String(error)); }
};
if (existsSync(portfolioPath)) syncPortfolio(db,loadPortfolioFile(portfolioPath));
else log.info('Run coach portfolio generate to create portfolio.yaml');
watchFile(portfolioPath, {interval:1000}, reload);
const collectors = collectorRegistry(config);
const scheduler = createScheduler(collectors,{db,config,exec:run,now:() => new Date(),log});
const server = listen(createApp({db,config,collectors,portfolioPath}),config);
scheduler.start();
// Telegram (PLAN.md §8): coachme's own bot, long polling, only Anton's chat. Without the two
// env values the review is still written to /review and capture works in the UI and CLI.
const now = () => new Date();
const ai = { db, config: config.ai, timeZone: config.owner_tz, now, log };
const today = { db, ai, githubOwner: config.github_owner, timeZone: config.owner_tz, now };
const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
const telegram = token && chatId ? createTelegram(token) : null;
const send = telegram && chatId ? (html: string) => telegram.send(chatId, html) : null;
const reviewUrl = `http://${config.host}:${config.port}/review`;
const rhythm = startRhythm({ db, ai, today, timeZone: config.owner_tz, notify: config.notify, now, log, send, reviewUrl, backupDir: resolve('data/backups') });
const bot = telegram && chatId ? startBot({ db, chatId, now, telegram, log, today: async () => (await todayText({ db, today, now })) ?? 'Nothing broken and no open tasks.' }) : null;
log.info(telegram ? 'Telegram bot on (long polling)' : 'Telegram off: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.local');
log.info(`coachme listening on http://${config.host}:${config.port}`);
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { scheduler.stop(); rhythm.stop(); void bot?.stop(); unwatchFile(portfolioPath); server.close(() => process.exit(0)); });
