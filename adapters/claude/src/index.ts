export * from './paths.js';

export const plugin = {
  id: 'claude',
  displayName: 'Claude Code',
  create() {
    return { id: 'claude', displayName: 'Claude Code' };
  },
};
export default plugin;
