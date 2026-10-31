/**
 * Persistent extension state.
 * - settings and the session live in `chrome.storage.local` (survive restarts;
 *   the session token is refreshed daily and lasts until you sign out).
 * - unsaved form drafts live in `chrome.storage.session` (cleared when the
 *   browser closes) so closing the popup to copy something doesn't lose input.
 */

export const DEFAULT_SETTINGS = {
  /** iamcandidate-server base URL (the deployed API; local `npm run dev` listens on 3001). */
  apiUrl: "https://ps4y8f4z9f.execute-api.ap-south-1.amazonaws.com",
  /** IamCandidate web app, used for "Open in IamCandidate" links. */
  appUrl: "https://knot-ui-eight.vercel.app",
}

/** The previous default, still saved by anyone who opened Settings. */
const OLD_DEFAULT_APP_URL = "http://localhost:3000"

const SETTINGS_KEY = "iamcandidate:settings"
export const SESSION_KEY = "iamcandidate:session"
const DRAFT_KEY = "iamcandidate:draft"

const trimSlash = (url) => String(url ?? "").trim().replace(/\/+$/, "")

export async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY)
  const apiUrl = trimSlash(saved?.apiUrl) || DEFAULT_SETTINGS.apiUrl
  let appUrl = trimSlash(saved?.appUrl) || DEFAULT_SETTINGS.appUrl
  // Against the deployed API, a localhost app URL is the old default, not a choice.
  if (appUrl === OLD_DEFAULT_APP_URL && apiUrl === DEFAULT_SETTINGS.apiUrl) {
    appUrl = DEFAULT_SETTINGS.appUrl
  }
  return { apiUrl, appUrl }
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

const LAST_APPLICATION_KEY = "iamcandidate:last-application"

/** The application saved most recently from this browser session, so a
 * referral added next (e.g. on an employee's profile) can link to it. */
export async function getLastApplicationId() {
  const { [LAST_APPLICATION_KEY]: id } = await chrome.storage.session.get(LAST_APPLICATION_KEY)
  return id
}

export async function setLastApplicationId(id) {
  await chrome.storage.session.set({ [LAST_APPLICATION_KEY]: id })
}

export const AUTOFILL_KEY = "iamcandidate:autofill"
export const ANSWERS_KEY = "iamcandidate:answers"

/** Your details for filling application forms, kept on this device for the
 * signed-in user (`{ userId, details }`) until you sign out. The form filler
 * also writes here, from the page, when you type a missing detail into a form. */
export async function getAutofill(userId) {
  const { [AUTOFILL_KEY]: saved } = await chrome.storage.local.get(AUTOFILL_KEY)
  return saved?.userId === userId ? saved.details : undefined
}

export async function saveAutofill(userId, details) {
  await chrome.storage.local.set({ [AUTOFILL_KEY]: { userId, details } })
}

/** Answers to other questions, learned from the forms you fill in
 * (`{ userId, answers: { [question]: { label, value, savedAt } } }`). */
export async function getAnswers(userId) {
  const { [ANSWERS_KEY]: saved } = await chrome.storage.local.get(ANSWERS_KEY)
  return saved?.userId === userId ? (saved.answers ?? {}) : {}
}

export async function saveAnswers(userId, answers) {
  await chrome.storage.local.set({ [ANSWERS_KEY]: { userId, answers } })
}

export async function clearAutofill() {
  await chrome.storage.local.remove([AUTOFILL_KEY, ANSWERS_KEY])
}

const JOBS_KEY = "iamcandidate:jobs"
/** How long a job you looked at is remembered for its application form. */
const JOB_TTL_MS = 2 * 60 * 60 * 1000

/** Remembers the posting read in a tab, so its application form (often a
 * separate page without the description) can still be matched to your resume. */
export async function rememberJob(tabId, job) {
  const { [JOBS_KEY]: jobs = {} } = await chrome.storage.session.get(JOBS_KEY)
  const now = Date.now()
  const kept = Object.fromEntries(Object.entries(jobs).filter(([, entry]) => now - entry.at < JOB_TTL_MS))
  await chrome.storage.session.set({ [JOBS_KEY]: { ...kept, [tabId]: { job, at: now } } })
}

/** The posting last read in this tab, else the one read most recently in any tab. */
export async function recallJob(tabId) {
  const { [JOBS_KEY]: jobs = {} } = await chrome.storage.session.get(JOBS_KEY)
  const fresh = Object.entries(jobs).filter(([, entry]) => Date.now() - entry.at < JOB_TTL_MS)
  const own = fresh.find(([id]) => id === String(tabId))
  const latest = fresh.sort(([, a], [, b]) => b.at - a.at)[0]
  return (own ?? latest)?.[1].job
}

export const AUTO_FILL_KEY = "iamcandidate:auto-fill"

/** Whether application forms are filled as soon as they open (on by default;
 * it also needs access to sites, granted from the autofill panel). */
export async function getAutoFill() {
  const { [AUTO_FILL_KEY]: on } = await chrome.storage.local.get(AUTO_FILL_KEY)
  return on !== false
}

export async function setAutoFill(on) {
  await chrome.storage.local.set({ [AUTO_FILL_KEY]: !!on })
}
