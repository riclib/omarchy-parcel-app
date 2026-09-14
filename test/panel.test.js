const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

test('panel closes with a read-only bar API and releases input if the setter fails', () => {
  const qml = readFileSync(join(__dirname, '../Panel.qml'), 'utf8');
  const functions = ['close', 'setCenterHoverRevealSuppressed'].map(name => {
    const match = qml.match(new RegExp(`  function ${name}\\([^]*?\\n  }`));
    assert.ok(match);
    return match[0];
  }).join('\n');
  let hidden = false;
  let suppressed = true;
  const bar = {
    get centerHoverRevealSuppressed() { return suppressed; },
    setCenterHoverRevealSuppressed(value) { suppressed = value; }
  };
  const context = { root: { bar, controller: { hide() { hidden = true; } } } };
  runInNewContext(functions + '\nclose()', context);
  assert.equal(suppressed, false);
  assert.equal(hidden, true);
  hidden = false;
  bar.setCenterHoverRevealSuppressed = () => { throw new Error('setter failed'); };
  assert.throws(() => runInNewContext(functions + '\nclose()', context), /setter failed/);
  assert.equal(hidden, true);
});
