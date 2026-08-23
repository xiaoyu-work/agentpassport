export * from './paths.js';

export const plugin = {
  id: 'openclaw',
  displayName: 'OpenClaw',
  create() {
    return { id: 'openclaw', displayName: 'OpenClaw' };
  },
};
export default plugin;
