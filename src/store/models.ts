/** Core data model. Notes and folders live in IndexedDB (source of truth) and mirror to Drive. */

export type ID = string;

export interface Note {
  id: ID;
  /** Parent folder id, or 'root'. */
  folderId: ID;
  title: string;
  /** Full markdown body (without the metadata front-matter; that is derived on export). */
  markdown: string;
  tags: string[];
  /** UPSC syllabus topic codes, e.g. 'GS2/Polity/Parliament'. */
  syllabus: string[];
  createdAt: number;
  updatedAt: number;
  /** sha-256 of markdown at last sync, to detect local vs remote changes. */
  syncedHash?: string;
  /** Drive file id once synced. */
  driveFileId?: string;
  /** Drive modifiedTime seen at last sync. */
  driveModified?: string;
  /** Published to the public profile? */
  published: boolean;
  /** URL slug within the profile, e.g. 'polity-basic-structure'. */
  slug?: string;
  /** Soft-delete marker; kept so the deletion can propagate to Drive. */
  trashed?: boolean;
  order: number;
}

export interface Folder {
  id: ID;
  parentId: ID; // 'root' for top level
  name: string;
  /** One of the built-in UPSC sections, if this is a seeded folder. */
  section?: string;
  createdAt: number;
  order: number;
  collapsed?: boolean;
}

export interface Asset {
  id: ID;
  noteId: ID;
  name: string;
  mime: string;
  blob: Blob;
  driveFileId?: string;
  /** anyone-with-link URL once the owning note is published. */
  publicUrl?: string;
  createdAt: number;
}

export interface Snapshot {
  id: ID;
  noteId: ID;
  markdown: string;
  title: string;
  at: number;
}

export interface Meta {
  key: string;
  value: unknown;
}

export interface UserProfile {
  sub: string;
  email: string;
  name: string;
  picture: string;
  /** Claimed username, once the student has one. */
  username?: string;
  displayName?: string;
  bio?: string;
  /** Drive file id of the public profile.json. */
  profileFileId?: string;
  profileFileUrl?: string;
}

export const ROOT = 'root';
export const uid = () => crypto.randomUUID();
