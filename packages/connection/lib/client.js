// Placeholder browser bundle: replaced by the built SSE carrier (see src/client.ts).
// Present so the module host's composition validation resolves a bundle path.
window.__ModuleLoader__.load({ id: "@dsh-desktop/connection", factory: (require) => {
  var module = { exports: {} };
  module.exports.name = 'desktop-connection';
  module.exports.inject = [];
  module.exports.apply = function () {
    throw new Error('desktop-connection client: placeholder bundle — run the client build');
  };
  return module.exports;
} });
