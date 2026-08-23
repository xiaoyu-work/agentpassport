export type ChangeOperation = 'create' | 'update' | 'delete' | 'unchanged';

export interface ConfigChange {
  op: ChangeOperation;
  file: string;
  description: string;
  before?: string;
  after?: string;
}

/** Classify a proposed write by comparing it with what is already on disk. */
export function describeChange(
  file: string,
  before: string | undefined,
  after: string | undefined,
  description: string,
): ConfigChange {
  let op: ChangeOperation;
  if (before === undefined && after !== undefined) op = 'create';
  else if (before !== undefined && after === undefined) op = 'delete';
  else if (before === after) op = 'unchanged';
  else op = 'update';

  return {
    op,
    file,
    description,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

export function hasEffect(changes: ConfigChange[]): boolean {
  return changes.some((c) => c.op !== 'unchanged');
}
