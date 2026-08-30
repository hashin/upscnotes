import { config } from '../config';
import { getDriveToken, invalidateDriveToken } from '../auth/google';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  appProperties?: Record<string, string>;
  parents?: string[];
  trashed?: boolean;
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Background Drive I/O always uses a silent token; the "Connect Drive" button is the
  // only place that may show consent UI.
  let token = await getDriveToken(true);
  let res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // Token rejected — force one refresh, then give up (sync surfaces a reconnect prompt).
    invalidateDriveToken();
    token = await getDriveToken(true).catch(() => '');
    if (!token) throw new Error('drive-unauthorized');
    res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error('drive-unauthorized');
  }
  if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Find (or create) the app's root folder in the user's Drive. Tagged via appProperties. */
export async function ensureRootFolder(): Promise<string> {
  const q = encodeURIComponent(
    `mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='upscnotes' and value='root' }`,
  );
  const found = await (
    await driveFetch(`${API}/files?q=${q}&fields=files(id,name)&spaces=drive`)
  ).json();
  if (found.files?.length) return found.files[0].id as string;

  const created = await (
    await driveFetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: config.DRIVE_FOLDER_NAME,
        mimeType: FOLDER_MIME,
        appProperties: { upscnotes: 'root' },
      }),
    })
  ).json();
  return created.id as string;
}

export async function ensureSubFolder(parentId: string, name: string, key: string): Promise<string> {
  const q = encodeURIComponent(
    `mimeType='${FOLDER_MIME}' and trashed=false and '${parentId}' in parents and appProperties has { key='upscnotes-folder' and value='${key}' }`,
  );
  const found = await (await driveFetch(`${API}/files?q=${q}&fields=files(id)`)).json();
  if (found.files?.length) return found.files[0].id as string;
  const created = await (
    await driveFetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
        appProperties: { 'upscnotes-folder': key },
      }),
    })
  ).json();
  return created.id as string;
}

export async function listFiles(rootId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`trashed=false and appProperties has { key='upscnotes-note' and value='1' }`);
    const url = `${API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,appProperties,parents)&pageSize=200${
      pageToken ? `&pageToken=${pageToken}` : ''
    }`;
    const data = await (await driveFetch(url)).json();
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);
  void rootId;
  return files;
}

function multipartBody(metadata: object, content: string | Blob, contentType: string): { body: Blob; boundary: string } {
  const boundary = 'upsc' + Math.random().toString(36).slice(2);
  const parts: BlobPart[] = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ];
  return { body: new Blob(parts), boundary };
}

export async function createFile(
  parentId: string,
  name: string,
  content: string,
  appProperties: Record<string, string>,
): Promise<DriveFile> {
  const { body, boundary } = multipartBody(
    { name, parents: [parentId], mimeType: 'text/markdown', appProperties: { 'upscnotes-note': '1', ...appProperties } },
    content,
    'text/markdown',
  );
  const res = await driveFetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime,appProperties,parents`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

export async function updateFile(
  fileId: string,
  content: string,
  appProperties?: Record<string, string>,
  name?: string,
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = {};
  if (appProperties) metadata.appProperties = appProperties;
  if (name) metadata.name = name;
  const { body, boundary } = multipartBody(metadata, content, 'text/markdown');
  const res = await driveFetch(
    `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,name,modifiedTime,appProperties,parents`,
    { method: 'PATCH', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
  );
  return res.json();
}

export async function downloadFile(fileId: string): Promise<string> {
  const res = await driveFetch(`${API}/files/${fileId}?alt=media`);
  return res.text();
}

export async function trashFile(fileId: string): Promise<void> {
  await driveFetch(`${API}/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

export async function uploadBlob(
  parentId: string,
  name: string,
  blob: Blob,
  appProperties: Record<string, string> = {},
): Promise<DriveFile> {
  const { body, boundary } = multipartBody(
    { name, parents: [parentId], appProperties },
    blob,
    blob.type || 'application/octet-stream',
  );
  const res = await driveFetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

/** Make a file readable by anyone with the link. Returns a direct-content URL. */
export async function makePublic(fileId: string): Promise<string> {
  await driveFetch(`${API}/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }),
  }).catch((e) => {
    if (!String(e).includes('already')) throw e;
  });
  return publicContentUrl(fileId);
}

export async function makePrivate(fileId: string): Promise<void> {
  const perms = await (await driveFetch(`${API}/files/${fileId}/permissions?fields=permissions(id,type)`)).json();
  const anyone = (perms.permissions ?? []).find((p: any) => p.type === 'anyone');
  if (anyone) await driveFetch(`${API}/files/${fileId}/permissions/${anyone.id}`, { method: 'DELETE' });
}

/**
 * Public, CORS-enabled content URL for an anyone-with-link file. Uses the browser API key
 * so the public-profile pages can read note bodies without any signed-in session.
 */
export function publicContentUrl(fileId: string): string {
  const key = config.GOOGLE_API_KEY ? `&key=${config.GOOGLE_API_KEY}` : '';
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media${key}`;
}

export async function about(): Promise<{ user: { emailAddress: string } }> {
  return (await driveFetch(`${API}/about?fields=user(emailAddress)`)).json();
}
