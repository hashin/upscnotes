import { apiUrl } from '../config';

export interface RegistryRecord {
  username: string;
  profileUrl: string;
  updatedAt: number;
}

/** Username -> profile pointer, served by the Worker from D1 with edge caching. */
export function registryUrl(username: string): string {
  return apiUrl(`/u/${encodeURIComponent(username.toLowerCase())}`);
}
