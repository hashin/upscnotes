/**
 * Public configuration. Every value here is safe to commit — none of it is a secret.
 *
 * Fill these in after completing docs/SETUP.md. Until GOOGLE_CLIENT_ID is set the app
 * runs in "local-only" mode: the full editor, offline storage, templates and export all
 * work; only Google sign-in, Drive sync and publishing are disabled.
 */

export const config = {
  /** OAuth 2.0 Web client ID from Google Cloud Console. Ends in `.apps.googleusercontent.com`. */
  GOOGLE_CLIENT_ID: '' as string,

  /**
   * Browser API key (Google Cloud Console -> Credentials -> API key), restricted to the
   * Drive API and to HTTP referrers upscnotes.hashin.me / localhost. Used only to read
   * public, anyone-with-link note files when rendering someone's public profile.
   */
  GOOGLE_API_KEY: '' as string,

  /** Base URL of the Cloudflare Pages Function API. Same origin in production; set for local dev if needed. */
  API_BASE: '' as string, // e.g. 'https://upscnotes.hashin.me'  (empty = same origin)

  /** Public base URL of the R2 registry bucket that maps username -> profile pointer. */
  REGISTRY_BASE: 'https://registry.upscnotes.hashin.me' as string,

  /** Canonical site URL, used for share links and SEO tags. */
  SITE_URL: 'https://upscnotes.hashin.me' as string,

  /** Google Drive folder the app creates in each student's Drive. */
  DRIVE_FOLDER_NAME: 'UPSC Notes',

  /** OAuth scope. drive.file is non-sensitive: only files this app creates are visible to it. */
  DRIVE_SCOPE: 'https://www.googleapis.com/auth/drive.file',
} as const;

export const cloudEnabled = () => config.GOOGLE_CLIENT_ID.trim().length > 0;

export const apiUrl = (path: string) =>
  (config.API_BASE ? config.API_BASE.replace(/\/$/, '') : '') + path;
