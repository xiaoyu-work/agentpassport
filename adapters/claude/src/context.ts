export interface AdapterContextLike {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  device?: string;
  deviceId?: string;
}
