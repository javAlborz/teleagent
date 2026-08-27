'use strict';

/**
 * Start observing a provider wrapper before any readiness work is awaited.
 * ChildProcess does not replay `exit`; callers must retain this promise from
 * the same event-loop turn in which they spawn the child.
 */
function observeChildExit(child) {
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // A different readiness promise may reject first. Installing an observer
  // here prevents that ordering from creating an unhandled rejection while
  // preserving rejection for a later explicit await.
  void completion.catch(() => {});
  return completion;
}

module.exports = { observeChildExit };
