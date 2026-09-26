import { redact } from './redact.js';
export interface Logger { info(message: string): void; warn(message: string): void; error(message: string): void }
export const log: Logger = {
  info: message => console.info(redact(message)),
  warn: message => console.warn(redact(message)),
  error: message => console.error(redact(message)),
};
