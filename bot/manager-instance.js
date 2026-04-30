'use strict';

// Shared singleton holder so bot/index.js and dashboard/server.js can
// reference the SAME SessionManager without circular requires.

let _manager = null;

module.exports = {
  setManager: (m) => { _manager = m; },
  getManager: () => _manager,
};
