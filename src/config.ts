/**
 * Public configuration. Every value here is safe to commit — none of it is a secret.
 *
 * Fill these in after completing docs/SETUP.md. Until GOOGLE_CLIENT_ID is set the app
 * runs in "local-only" mode: the full editor, offline storage, templates and export all
 * work; only Google sign-in, Drive sync and publishing are disabled.
 */

export const config = {
  /** OAuth 2.0 Web client ID from Google Cloud Console. Ends in `.apps.googleusercontent.com`. */
  GOOGLE_CLIENT_ID: '157486155350-8qsefn3gudhk8f5co0hbmki6243b86nq.apps.googleusercontent.com' as string,

  /**
   * Browser API key (Google Cloud Console -> Credentials -> API key), restricted to the
   * Drive API and to HTTP referrers upscnotes.hashin.me / localhost. Used only to read
   * public, anyone-with-link note files when rendering someone's public profile.
   */
  GOOGLE_API_KEY: 'AIzaSyCYsOL-qmCHxSCGBmI86huHJ5sorQqMJqk' as string,

  /**
   * Base URL of the registry API (Cloudflare Worker). The static site is on GitHub Pages,
   * so this points at the deployed Worker, e.g. 'https://upscnotes-api.<account>.workers.dev'.
   * It handles username claim/check, Google-token verification, and public username->profile
   * lookups (`GET /u/<name>`, edge-cached). Leave empty until the Worker exists — sign-in and
   * publishing stay disabled and the rest of the app works.
   */
  API_BASE: '' as string,

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
