import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);
const entry = join(root,'dist/server.js');
function newest(path) { return Math.max(0,...readdirSync(path,{withFileTypes:true}).map(e => e.isDirectory() ? newest(join(path,e.name)) : statSync(join(path,e.name)).mtimeMs)); }
if (!existsSync(entry) || newest(join(root,'src')) > statSync(entry).mtimeMs) execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:root,stdio:'inherit',windowsHide:true});
await import(new URL('../dist/server.js',import.meta.url).href);
