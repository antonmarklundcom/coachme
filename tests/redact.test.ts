import { describe,it,expect,vi } from 'vitest';
import { redact } from '../src/lib/redact.js';
import { log } from '../src/lib/log.js';
describe('redaction',() => {
  it('removes every listed secret shape assembled from fake fragments',() => {
    const fake = 'FAKE_VALUE_FOR_TESTING';
    const values = [
      ...['sk-ant-','sk-','ghp_','github_pat_','gho_','xoxb-','xoxp-'].map(prefix => prefix + fake),
      'AKIA' + 'Z'.repeat(16), ['eyJfake','payload','signature'].join('.'),
      ['-----BEGIN RSA PRIVATE KEY-----',fake,'-----END RSA PRIVATE KEY-----'].join('\n'),
      'Bearer ' + fake, ...['password','passwd','secret','token','api_key'].map(key => `${key}=${fake}`),
      `https://${'fake-user'}:${fake}@service.test/path`, `FAKE_ENV=${fake}`, 'a'.repeat(40), 'Q'.repeat(35) + '+/==',
    ];
    for (const value of values) { expect(redact(value)).toContain('[REDACTED]'); expect(redact(value)).not.toContain(fake); expect(redact(value)).not.toBe(value); }
  });
  it('preserves normal prose and sanitizes all logger levels',() => {
    const prose = 'Propia has 3 dirty files. Stage: building. Visit https://propia.com.py.';
    expect(redact(prose)).toBe(prose);
    for (const level of ['info','warn','error'] as const) {
      const spy = vi.spyOn(console,level).mockImplementation(() => {});
      log[level]('token=' + 'fake-test-value'); expect(spy).toHaveBeenCalledWith('[REDACTED]'); spy.mockRestore();
    }
  });
});
