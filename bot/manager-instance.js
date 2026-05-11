'use strict';

// Singleton holder so bot and dashboard share one SessionManager without
// circular requires.

let _manager = null;

module.exports = {
  setManager: (m) => { _manager = m; },
  getManager: () => _manager,
};
