import type { DB } from '../db/index.js';
import type { Config } from '../config.js';
import type { Exec } from '../lib/exec.js';
import type { Logger } from '../lib/log.js';
export interface CollectorContext { db: DB; config: Config; exec: Exec; now: () => Date; log: Logger }
export interface Collector { name: string; intervalMin: number; run(ctx: CollectorContext): Promise<number> }
