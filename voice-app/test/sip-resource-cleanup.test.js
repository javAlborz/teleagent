'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { destroySipResource } = require('../lib/sip-resource-cleanup');
const { InboundCallRegistry } = require('../lib/inbound-call-registry');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('goodbye and handler cleanup share one in-flight BYE, allowing the next call', async () => {
  const registry = new InboundCallRegistry();
  registry.startAccepting();
  const bye = deferred();
  const issued = deferred();
  let sends = 0;
  const dialog = {
    connected: true,
    destroy() {
      assert.equal(++sends, 1, 'Drachtio rejects a duplicate BYE');
      issued.resolve();
      return bye.promise.then(() => { this.connected = false; });
    },
  };
  const first = registry.dispatch({}, {}, async ({ onResources }) => {
    onResources({ dialog, cleanup: () => destroySipResource(dialog) });
    const hangup = destroySipResource(dialog);
    assert.equal(destroySipResource(dialog), hangup);
    // Conversation completion can return before the local hangup resolves.
  });
  await issued.promise;
  let drained = false;
  first.then(() => { drained = true; });
  await new Promise(setImmediate);
  assert.equal(drained, false);
  bye.resolve();
  await first;
  assert.equal(sends, 1);
  assert.equal(registry.getStatus().cleanupUncertain, false);
  let answered = false;
  await registry.dispatch({}, {}, async () => { answered = true; });
  assert.equal(answered, true);
  assert.equal((await registry.shutdown()).safeToClose, true);
});

test('an already disconnected remote dialog is not sent another BYE', async () => {
  await destroySipResource({ connected: false, destroy() { throw Error('duplicate BYE'); } });
});

test('a failed BYE stays failed even when the library marks the dialog disconnected', async () => {
  let sends = 0;
  const failure = new Error('BYE outcome unknown');
  const dialog = {
    connected: true,
    async destroy() { sends += 1; this.connected = false; throw failure; },
  };
  const first = destroySipResource(dialog);
  await assert.rejects(first, error => error === failure);
  assert.equal(destroySipResource(dialog), first);
  await assert.rejects(destroySipResource(dialog), error => error === failure);
  assert.equal(sends, 1);
  const registry = new InboundCallRegistry();
  registry.startAccepting();
  await registry.dispatch({}, {}, async ({ onResources }) => {
    onResources({ dialog, cleanup: () => destroySipResource(dialog) });
  });
  assert.equal(registry.getStatus().cleanupUncertain, true);
  assert.equal((await registry.shutdown()).safeToClose, false);
});

test('concurrent endpoint teardown waits for its first attempt after connected becomes false', async () => {
  const ended = deferred();
  let destroys = 0;
  const endpoint = { connected: true, destroy() {
    destroys += 1; this.connected = false; return ended.promise;
  } };
  const first = destroySipResource(endpoint);
  await new Promise(setImmediate);
  assert.equal(endpoint.connected, false);
  assert.equal(destroySipResource(endpoint), first);
  ended.resolve();
  await first;
  assert.equal(destroys, 1);
});
