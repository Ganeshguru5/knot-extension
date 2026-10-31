import { api, originPattern } from "./lib/api.js"
import { fillPage } from "./lib/autofill.js"
import { clearReport, reportKey, saveReport } from "./lib/report.js"
import { preferredResume, resumeFile } from "./lib/resume-file.js"
import {
  ANSWERS_KEY,
  AUTOFILL_KEY,
  getAnswers,
  getAutoFill,
  getAutofill,
  getSession,
  getSettings,
} from "./lib/storage.js"

/**
 * Fills job application forms as soon as they open, without a click: when a
 * page finishes loading (or a single-page app changes its URL), it checks
 * whether the page is a job application and, if so, fills it like the panel's
 * Autofill button does. It never submits; the badge counts the required
 * questions left for you, and the panel shows the full report.
 *
 * Runs only when you're signed in, auto-fill is on, and you've given the
 * extension access to the site. Never on IamCandidate's own pages.
 */

/** Forms often render after the page loads, so it looks a few times. */
const ATTEMPTS_MS = [1200, 3500, 8000]
const RESUME_CACHE_MS = 10 * 60 * 1000

/** tabId → `{ url, timers, done, busy }` while waiting to fill. */
const pending = new Map()
/** tabId → the URL already filled, so a page isn't filled twice. */
const filled = new Map()
let resumeCache

const isHttpUrl = (value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol)
  } catch {
    return false
  }
}

const sameHost = (a, b) => {
  try {
    return new URL(a).hostname === new URL(b).hostname
  } catch {
    return false
  }
}

function cancel(tabId) {
  for (const timer of pending.get(tabId)?.timers ?? []) clearTimeout(timer)
  pending.delete(tabId)
}

function schedule(tabId, url) {
  if (!isHttpUrl(url) || filled.get(tabId) === url) return
  cancel(tabId)
  const entry = { url, done: false, busy: false, timers: [] }
  entry.timers = ATTEMPTS_MS.map((ms) => setTimeout(() => void attempt(tabId, entry), ms))
  pending.set(tabId, entry)
}

async function attempt(tabId, entry) {
  if (entry.done || entry.busy) return
  entry.busy = true
  try {
    if (await autoFill(tabId, entry.url)) {
      entry.done = true
      cancel(tabId)
    }
  } catch (error) {
    // Pages Chrome won't let us script, closed tabs…
    console.warn("IamCandidate: auto-fill skipped", error)
  } finally {
    entry.busy = false
  }
}

/** Resolves true when it's done with this page (filled, or not allowed to),
 * false when it found no application yet and should look again. */
async function autoFill(tabId, url) {
  if (!(await getAutoFill())) return true
  const [settings, session] = await Promise.all([getSettings(), getSession()])
  if (!session || (session.apiUrl && session.apiUrl !== settings.apiUrl)) return true
  if (sameHost(settings.appUrl, url) || sameHost(settings.apiUrl, url)) return true
  if (!(await chrome.permissions.contains({ origins: [originPattern(url)] }))) return true
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (tab?.url !== url) return true

  const userId = session.user?.id ?? session.user?.email
  const [saved, answers] = await Promise.all([getAutofill(userId), getAnswers(userId)])
  const details = saved ?? { fullName: session.user?.name ?? "", email: session.user?.email ?? "" }
  const target = { tabId, allFrames: true }

  const probes = await chrome.scripting.executeScript({
    target,
    func: fillPage,
    args: [details, answers, undefined, undefined, { detectOnly: true }],
  })
  if (!probes.some((r) => r?.result?.application)) return false

  const { file } = await cachedResume()
  const results = await chrome.scripting.executeScript({
    target,
    func: fillPage,
    args: [
      details,
      answers,
      { userId, detailsKey: AUTOFILL_KEY, answersKey: ANSWERS_KEY },
      file,
      { onlyApplications: true },
    ],
  })
  const fields = results.flatMap((r) => (r?.result?.fields ?? []).map((field) => ({ ...field, frameId: r.frameId })))
  filled.set(tabId, url)
  await saveReport(tabId, url, fields, { auto: true })
  return true
}

/** Your resume's file, kept for a few minutes so applying to several jobs doesn't re-download it. */
async function cachedResume() {
  const resumes = await api.listResumes().catch(() => [])
  const resume = await preferredResume(resumes ?? [])
  if (!resume) return {}
  const fresh =
    resumeCache?.id === resume.id &&
    resumeCache.updatedAt === resume.updatedAt &&
    Date.now() - resumeCache.at < RESUME_CACHE_MS
  if (!fresh) resumeCache = { id: resume.id, updatedAt: resume.updatedAt, at: Date.now(), result: await resumeFile(resume) }
  return resumeCache.result
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) {
    cancel(tabId)
    filled.delete(tabId)
    void clearReport(tabId)
  }
  if (change.status === "complete" || change.url) schedule(tabId, tab.url)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  cancel(tabId)
  filled.delete(tabId)
  void chrome.storage.session.remove(reportKey(tabId))
})
