export * from './paths.js';

/** Adapter shim: just enough for the plugin loader to accept it. */
export const plugin = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  create() {
    return { id: 'codex', displayName: 'OpenAI Codex CLI' };
  },
};
export default plugin;
