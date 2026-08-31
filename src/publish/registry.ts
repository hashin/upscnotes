import { apiUrl } from '../config';

/** The Worker serves the whole public profile (from D1) at this URL. */
export function profileApiUrl(username: string): string {
  return apiUrl(`/u/${encodeURIComponent(username.toLowerCase())}`);
}
