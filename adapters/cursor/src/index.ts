export * from './paths.js';

export const plugin = {
  id: 'cursor',
  displayName: 'Cursor',
  create() {
    return { id: 'cursor', displayName: 'Cursor' };
  },
};
export default plugin;
