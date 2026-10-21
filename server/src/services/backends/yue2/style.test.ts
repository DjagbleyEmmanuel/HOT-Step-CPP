import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyYue2StyleTemplate, yue2StyleSelfCheck } from './style.js';

const want = 't, in the style of t. rock';

test('branch table still matches the engine', () => {
  assert.deepEqual(yue2StyleSelfCheck(), []);
});

// #238: the create path prefixes "<trigger>, " before YuE2 adds its own opener.
test('strips a bare leading "<trigger>," before composing', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: 't, rock' }), want);
});

test('bare trigger strip is case-insensitive', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: 'T, rock' }), want);
});

test('repeated bare prefixes all go', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: 't, t, t, rock' }), want);
});

test('a trigger that only prefixes a longer word is kept', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: 'tango, rock' }), 't, in the style of t. tango, rock');
});

test('full opener and bare prefix together collapse to one opener, either order', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: 't, in the style of t. t, rock' }), want);
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: 't, t, in the style of t. rock' }), want);
});

test('a caption that is only the trigger word is kept as the genre', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 'rock', caption: 'rock,' }), 'rock, in the style of rock. rock,');
});

test('regex metacharacters in the trigger are literal', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 'a.b', caption: 'a.b, rock' }), 'a.b, in the style of a.b. rock');
  assert.equal(applyYue2StyleTemplate({ trigger: 'a.b', caption: 'axb, rock' }), 'a.b, in the style of a.b. axb, rock');
});

test('bare template is untouched by the bare-prefix strip', () => {
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: 't, t, rock', template: 'bare' }), 't, t, rock');
});

test('stays idempotent', () => {
  const once = applyYue2StyleTemplate({ trigger: 't', caption: 't, rock' });
  assert.equal(applyYue2StyleTemplate({ trigger: 't', caption: once }), once);
});
