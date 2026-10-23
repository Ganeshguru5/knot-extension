/**
 * Persistent extension state.
 * - settings and the session live in `chrome.storage.local` (survive restarts;
 *   the session token is refreshed daily and lasts until you sign out).
 * - unsaved form drafts live in `chrome.storage.session` (cleared when the
 *   browser closes) so closing the popup to copy something doesn't lose input.
 */

export const DEFAULT_SETTINGS = {
  /** knot-server base URL (the deployed API; local `npm run dev` listens on 3001). */
  apiUrl: "https://ps4y8f4z9f.execute-api.ap-south-1.amazonaws.com",
  /** knot web app, used for "Open in knot" links. */
  appUrl: "http://localhost:3000",
}

const SETTINGS_KEY = "knot:settings"
const SESSION_KEY = "knot:session"
const DRAFT_KEY = "knot:draft"

const trimSlash = (url) => String(url ?? "").trim().replace(/\/+$/, "")

export async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY)
  return {
    apiUrl: trimSlash(saved?.apiUrl) || DEFAULT_SETTINGS.apiUrl,
    appUrl: trimSlash(saved?.appUrl) || DEFAULT_SETTINGS.appUrl,
  }
}

export async function saveSettings(settings) {
  const next = { apiUrl: trimSlash(settings.apiUrl), appUrl: trimSlash(settings.appUrl) }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

/** `{ token, expiresAt, user, apiUrl }` or undefined when signed out / expired. */
export async function getSession() {
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY)
  if (!session?.token) return undefined
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    await clearSession()
    return undefined
  }
  return session
}

export async function saveSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session })
}

export async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY)
}

/** The draft for `url`, if the last unsaved form was on that page. */
export async function getDraft(url) {
  const { [DRAFT_KEY]: draft } = await chrome.storage.session.get(DRAFT_KEY)
  return draft?.url === url ? draft : undefined
}

export async function saveDraft(draft) {
  await chrome.storage.session.set({ [DRAFT_KEY]: draft })
}

export async function clearDraft() {
  await chrome.storage.session.remove(DRAFT_KEY)
}

const LAST_APPLICATION_KEY = "knot:last-application"

/** The application saved most recently from this browser session, so a
 * referral added next (e.g. on an employee's profile) can link to it. */
export async function getLastApplicationId() {
  const { [LAST_APPLICATION_KEY]: id } = await chrome.storage.session.get(LAST_APPLICATION_KEY)
  return id
}

export async function setLastApplicationId(id) {
  await chrome.storage.session.set({ [LAST_APPLICATION_KEY]: id })
}
