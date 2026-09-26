import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { configSchema } from '../src/config.js';
import { openDb,migrate, type DB } from '../src/db/index.js';
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8');
export const config = configSchema.parse({host:'127.0.0.1',port:4000,owner_tz:'America/Asuncion',local_roots:[],github_owner:'antonmarklundcom',collectors:{github:30,local:15},ai:{daily_usd_cap:0.5,model:'claude-sonnet-5'}});
const databases: DB[] = [], dirs: string[] = [];
export function testDb() { const db = openDb(':memory:'); migrate(db); databases.push(db); return db; }
export function tempDir() { const path = mkdtempSync(join(tmpdir(),'coachme-test-')); dirs.push(path); return path; }
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const path of dirs.splice(0)) rmSync(path,{recursive:true,force:true}); });
