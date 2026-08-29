import { config } from '../config';

/** Shard key so the R2 bucket never has one giant flat listing. */
export function registryPath(username: string): string {
  const u = username.toLowerCase();
  const prefix = (u.slice(0, 2).padEnd(2, '_')).replace(/[^a-z0-9]/g, '_');
  return `u/${prefix}/${u}.json`;
}

export function registryUrl(username: string): string {
  return `${config.REGISTRY_BASE.replace(/\/$/, '')}/${registryPath(username)}`;
}

export interface RegistryRecord {
  username: string;
  profileUrl: string;
  profileFileId: string;
  updatedAt: number;
}
