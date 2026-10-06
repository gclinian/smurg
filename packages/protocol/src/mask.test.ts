// mask(): what looks like a credential never reaches a stored or sent body.
import { describe, expect, it } from 'vitest';
import { MASKED, hasMaskable, mask } from './mask.ts';

const KEY20 = 'A1b2C3d4E5f6G7h8I9j0';

describe('mask', () => {
  it.each([
    ['an Anthropic key', `export ANTHROPIC_API_KEY=sk-ant-api03-${KEY20}${KEY20}`],
    ['an OpenAI key', `sk-proj-${KEY20}${KEY20} in the log`],
    ['a GitHub token', `remote: https://x:ghp_${KEY20}${KEY20}@github.com/a/b`],
    ['a fine-grained GitHub token', `github_pat_${KEY20}_${KEY20}`],
    ['an AWS access key id', 'aws_access_key_id AKIAIOSFODNN7EXAMPLE end'],
    ['a Slack token', `xoxb-1234567890-${KEY20}`],
    ['a Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
    ['a Google OAuth token', `ya29.${KEY20}${KEY20}`],
    ['an Authorization header', `curl -H "Authorization: Bearer ${KEY20}" https://api.example`],
    ['a basic Authorization header', 'authorization: Basic dXNlcjpwYXNzd29yZA=='],
    ['password=', 'postgres://db?user=amy&password=hunter2secret&ssl=1'],
    ['token:', 'token: 9f8e7d6c5b4a'],
    ['api_key=', 'API_KEY="abcd1234efgh"'],
    ['a prefixed secret', 'STRIPE_SECRET=whsec_abcdef123456'],
    ['client_secret', "client_secret: 'abcdef123456'"],
  ])('hides %s', (_what, text) => {
    const masked = mask(text);
    expect(masked).toContain(MASKED);
    expect(hasMaskable(text)).toBe(true);
    for (const secret of [KEY20, 'hunter2secret', '9f8e7d6c5b4a', 'abcd1234efgh', 'whsec_abcdef123456', 'abcdef123456', 'dXNlcjpwYXNzd29yZA', 'AKIAIOSFODNN7EXAMPLE', 'AIzaSyA1234567890']) {
      expect(masked.includes(secret), `${secret} left in: ${masked}`).toBe(false);
    }
  });

  it('hides a PEM private key block whole and keeps the text around it', () => {
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', 'AAAAEbm9uZQAAAAAAAAABAAAAMwAAAAt', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    expect(mask(`before\n${pem}\nafter`)).toBe(`before\n${MASKED}\nafter`);
    expect(mask('-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----')).toBe(MASKED);
    expect(mask('-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----')).toContain('MIIB');
  });

  it('keeps what is around a value: the name, the quotes, the rest of the line', () => {
    expect(mask('password=hunter2 and more')).toBe(`password=${MASKED} and more`);
    expect(mask('API_KEY="abcd1234"; next')).toBe(`API_KEY="${MASKED}"; next`);
    expect(mask('Authorization: Bearer abcdef123456')).toBe(`Authorization: ${MASKED}`);
  });

  it('leaves ordinary text, code and diffs alone', () => {
    for (const text of [
      'The cart lives in the session store.',
      '+  const total = items.reduce((sum, item) => sum + item.price, 0);',
      'pnpm test cart: 14 tests passed',
      'export function tokenize(input: string): Token[] {',
      'The password field is required.',
      'see https://example.com/docs?page=2',
      '',
    ]) {
      expect(mask(text), text).toBe(text);
      expect(hasMaskable(text)).toBe(false);
    }
  });

  it('is idempotent and never throws on odd input', () => {
    const once = mask(`token=${KEY20} sk-ant-api03-${KEY20} Authorization: Bearer ${KEY20}`);
    expect(mask(once)).toBe(once);
    expect(mask(undefined as unknown as string)).toBeUndefined();
    expect(mask('x'.repeat(300_000)).length).toBe(300_000);
  });
});
