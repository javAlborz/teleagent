"use strict";

// Share teardown completion across conversation, SIP-handler and shutdown paths.
// Drachtio dialogs expose `connected`, not `destroyed`, and reject a second BYE.
const attempts = new WeakMap();

function destroySipResource(resource) {
  if (!resource || typeof resource.destroy !== 'function') return Promise.resolve();
  // Retain an attempted teardown's rejection even if the library changed its
  // connection flag before reporting failure. A failed BYE is not proof of exit.
  if (attempts.has(resource)) return attempts.get(resource);
  if (resource.destroyed === true || resource.connected === false) return Promise.resolve();
  const completion = Promise.resolve().then(() => resource.destroy());
  attempts.set(resource, completion);
  return completion;
}

module.exports = { destroySipResource };
