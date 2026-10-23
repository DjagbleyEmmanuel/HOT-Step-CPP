import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, redact, MAX_URL_LENGTH } from './reportIssue';

const names = { home: 'C:\\Users\\jdoe', user: 'jdoe' };

test('redact masks home dir in both slash styles, user name, other profiles', () => {
  const out = redact('open C:\\Users\\jdoe\\Music\\a.wav and C:/Users/jdoe/x and /home/other/y by jdoe', names);
  assert.ok(!/jdoe|other/.test(out), out);
  assert.match(out, /~\\Music\\a\.wav/);
});

test('redact masks IPs, emails, tokens', () => {
  const out = redact([
    'listening on 192.168.1.20:8085 from ::ffff:10.0.0.1 and fe80:0:0:0:1:2:3:4',
    'mail me@example.com',
    'Authorization: Bearer abcdef1234567890abcdef',
    'HF_TOKEN=hf_abcdefghijklmnop1234567',
    'ghp_abcdefghijklmnopqrstuvwx',
    'sha 0123456789abcdef0123456789abcdef01234567',
  ].join('\n'), names);
  assert.ok(!/192\.168|10\.0\.0\.1|fe80|example\.com|abcdef1234567890|hf_abc|ghp_abc|0123456789abcdef0123456789abcdef01234567/.test(out), out);
  assert.match(out, /listening on <ip>:8085/);
});

test('redact leaves ordinary log text alone', () => {
  for (const line of ['[engine] loaded acestep-v15-turbo in 3.2 s on CUDA0', 'step 12:30:45 done', 'a::b namespace std::vector']) {
    assert.equal(redact(line, names), line);
  }
});

test('buildReport keeps the URL under the cap by trimming the oldest log lines first', () => {
  const lines = (tag: string) => Array.from({ length: 400 }, (_, i) => `${tag} line ${i} ` + 'x'.repeat(60));
  const parts = { title: 'Crash on render', description: 'It broke', system: 'OS: Windows', sections: [{ name: 'Server log', lines: lines('s') }, { name: 'Engine log', lines: lines('e') }] };
  const r = buildReport(parts);
  assert.ok(r.url.length <= MAX_URL_LENGTH, String(r.url.length));
  assert.ok(r.trimmed);
  assert.match(r.body, /s line 399/, 'newest line survives');
  assert.ok(!r.body.includes('s line 0 '), 'oldest line dropped');
  assert.match(r.url, /template=in-app-report\.md/);
});

test('buildReport leaves a short report untouched', () => {
  const r = buildReport({ title: 't', description: 'd', system: 'OS: x', sections: [{ name: 'Server log', lines: ['a'] }] });
  assert.equal(r.trimmed, false);
  assert.match(r.body, /## Description\n\nd/);
});

test('buildReport cuts the description only after the logs are gone', () => {
  const r = buildReport({ title: 't', description: 'é'.repeat(5000), system: 'OS: x', sections: [{ name: 'Server log', lines: ['a', 'b'] }] });
  assert.ok(r.url.length <= MAX_URL_LENGTH, String(r.url.length));
  assert.ok(!r.body.includes('## Logs'));
});
