const Module = require("node:module");
const mockLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Pure helper tests run in Node, where require("electron") has no app object.
// Logging is the only Electron dependency in these audio helpers.
function loadWithMockLogger(modulePath) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./debugLogger") return mockLogger;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = { loadWithMockLogger, mockLogger };
