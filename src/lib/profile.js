import { api, ApiError } from "./api.js"
import { getAnswers, getAutofill, getSession, saveAnswers, saveAutofill } from "./storage.js"

/**
 * Your autofill details live in IamCandidate (Career → Autofill, the server's
 * `/settings/autofill`). The extension keeps a copy on this device to fill
 * forms fast and offline, refreshed from the server before each fill, and
 * sends what you type on forms back to it.
 */

/** Where the form filler queues what it learns on a page: `{ userId, details, answers: [{ question, answer }] }`. */
export const LEARN_KEY = "iamcandidate:learned"

/** Same matching as the form filler and the server: no case, punctuation or "required" marks. */
export const questionKey = (question) =>
  String(question ?? "")
    .toLowerCase()
    .replace(/\((required|optional)\)|\brequired\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/** The server profile in the shape the form filler reads. */
export function toFillData(profile) {
  const { answers = [], updatedAt: _updatedAt, ...fields } = profile ?? {}
  return {
    details: {
      ...fields,
      fullName: [fields.firstName, fields.lastName].filter(Boolean).join(" "),
      location: fields.city ?? "",
    },
    answers: Object.fromEntries(
      answers.map((a) => [
        questionKey(a.question),
        { label: a.question, value: a.answer, savedAt: Date.parse(a.updatedAt ?? "") || 0 },
      ]),
    ),
  }
}

async function cache(userId, profile) {
  const data = toFillData(profile)
  await Promise.all([saveAutofill(userId, data.details), saveAnswers(userId, data.answers)])
  return data
}

/** Fresh details from IamCandidate, or the copy on this device when it can't be reached. */
export async function loadFillData(userId) {
  try {
    let profile = await api.getAutofillProfile()
    // Never saved in IamCandidate yet: bring over what earlier versions kept on this device only.
    if (!profile.updatedAt) profile = (await uploadLocalCopy(userId)) ?? profile
    return await cache(userId, profile)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error
    return { details: (await getAutofill(userId)) ?? {}, answers: await getAnswers(userId) }
  }
}

/** Details (name split into first and last) and answers that were only on this device. */
async function uploadLocalCopy(userId) {
  const [details, answers] = await Promise.all([getAutofill(userId), getAnswers(userId)])
  if (!details && !Object.keys(answers).length) return undefined
  const { fullName = "", location = "", ...rest } = details ?? {}
  const [firstName = "", ...others] = String(fullName).trim().split(/\s+/)
  const body = {
    details: sanitizeDetails({ firstName, lastName: others.join(" "), city: location, ...rest }),
    answers: Object.values(answers)
      .map((a) => ({ question: String(a.label ?? "").slice(0, 500), answer: String(a.value ?? "").slice(0, 5000) }))
      .filter((a) => a.question.trim() && a.answer.trim())
      .slice(0, 100),
  }
  if (!Object.keys(body.details).length && !body.answers.length) return undefined
  try {
    return await api.learnAutofill(body)
  } catch {
    return undefined
  }
}

/** Server field limits, so one long answer doesn't get the whole batch rejected. */
const LONG_FIELDS = { summary: 5000, coverLetter: 20000 }
const YES_NO_FIELDS = new Set(["workAuthorization", "needsSponsorship", "willingToRelocate"])
const URL_FIELDS = new Set(["linkedin", "github", "portfolio"])

/** The profile's text fields; the server rejects any other key. */
const PROFILE_FIELDS = new Set([
  "firstName", "lastName", "preferredName", "email", "phone", "pronouns",
  "addressLine", "city", "state", "postalCode", "country", "linkedin", "github", "portfolio",
  "currentTitle", "currentCompany", "experienceYears", "noticePeriod", "currentSalary", "expectedSalary",
  "workAuthorization", "needsSponsorship", "willingToRelocate",
  "school", "degree", "fieldOfStudy", "graduationYear",
  "gender", "ethnicity", "disability", "veteran", "summary", "coverLetter",
])

function sanitizeDetails(details) {
  const out = {}
  for (const [key, raw] of Object.entries(details ?? {})) {
    const value = String(raw ?? "").trim()
    if (!value || !PROFILE_FIELDS.has(key)) continue
    if (YES_NO_FIELDS.has(key)) {
      const answer = value.toLowerCase().match(/^(yes|no)\b/)?.[1]
      if (answer) out[key] = answer
    } else if (key === "email") {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) out[key] = value
    } else if (URL_FIELDS.has(key)) {
      if (value.length <= 2048) out[key] = value
    } else if (value.length <= (LONG_FIELDS[key] ?? 100)) {
      out[key] = value
    }
  }
  return out
}

/**
 * Sends what the form filler queued to IamCandidate and refreshes the copy
 * here. The queue is taken first, so answers typed meanwhile wait for the
 * next send; on a network error it's put back and this resolves false.
 */
export async function sendLearned() {
  const session = await getSession()
  const userId = session?.user?.id ?? session?.user?.email
  const { [LEARN_KEY]: queued } = await chrome.storage.local.get(LEARN_KEY)
  if (!queued) return
  await chrome.storage.local.remove(LEARN_KEY)
  if (!userId || queued.userId !== userId) return

  const body = {
    details: sanitizeDetails(queued.details),
    answers: (queued.answers ?? [])
      .map((a) => ({ question: String(a.question ?? "").trim().slice(0, 500), answer: String(a.answer ?? "").slice(0, 5000) }))
      .filter((a) => a.question && a.answer.trim())
      .slice(-100),
  }
  if (!Object.keys(body.details).length && !body.answers.length) return
  try {
    await cache(userId, await api.learnAutofill(body))
  } catch (error) {
    // Rejected (validation, signed out): drop it. Unreachable: try again next time.
    if (!(error instanceof ApiError) || error.status === 0) {
      const { [LEARN_KEY]: newer } = await chrome.storage.local.get(LEARN_KEY)
      await chrome.storage.local.set({
        [LEARN_KEY]: {
          userId,
          details: { ...queued.details, ...newer?.details },
          answers: [...(queued.answers ?? []), ...(newer?.answers ?? [])],
        },
      })
      return false
    }
  }
  return true
}
