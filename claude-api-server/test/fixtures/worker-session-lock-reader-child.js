'use strict';

const Database = require('better-sqlite3');

const database = new Database(process.argv[2], { timeout: 0 });
database.exec('BEGIN; SELECT name FROM sqlite_schema;');
process.send({ status: 'reader-held' });
process.once('message', (message) => {
  if (message !== 'release-soon') process.exit(2);
  // A different process must release this reader while the acquiring process
  // is inside SQLite's synchronous busy handler. No lifetime owner exists.
  setTimeout(() => {
    database.exec('ROLLBACK');
    database.close();
    process.send({ status: 'reader-released' }, () => process.exit(0));
  }, 100);
  process.send({ status: 'release-scheduled' });
});
