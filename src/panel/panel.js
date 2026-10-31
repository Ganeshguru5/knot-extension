import { api, ApiError } from "../lib/api.js"
import { fillPage, focusField } from "../lib/autofill.js"
import { extractPage } from "../lib/extract.js"
import { matchResume } from "../lib/match.js"
import { getReport, reportKey, saveReport } from "../lib/report.js"
import { RESUME_PREF_KEY, resumeFile } from "../lib/resume-file.js"
import {
  ANSWERS_KEY,
  AUTOFILL_KEY,
  AUTO_FILL_KEY,
  SESSION_KEY,
  getAnswers,
  getAutoFill,
  getAutofill,
  getSession,
  getSettings,
  recallJob,
  rememberJob,
  saveAnswers,
  saveAutofill,
  setAutoFill,
} from "../lib/storage.js"

/**
 * The autofill side panel: what job you're applying for, how your resume
 * matches it, and a field-by-field report after filling the form, with the
 * required questions still unanswered called out. It follows the active tab.
 */

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  settings: undefined,
  session: undefined,
  tab: undefined,
  /** `{ role, company, description, site }` for the job on (or behind) this page. */
  job: undefined,
  /** Whether the extension can script the current page. */
  readable: false,
  resumes: [],
  resumeId: "",
  answers: {},
  running: false,
}

/** Asked for on the first Autofill click, so the panel keeps working as you move between pages. */
const SITE_ACCESS = { origins: ["https://*/*", "http://*/*"] }
/** Set when the panel runs in its own window (browsers without side panels):
 * the browser window whose active tab it works on. */
const pageWindowId = Number(new URLSearchParams(location.search).get("window")) || undefined

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id)
const detailsForm = $("details-form")
const VIEWS = ["view-loading", "view-signed-out", "view-main"]

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view
}

function setAlert(el, message) {
  el.textContent = message ?? ""
  el.hidden = !message
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children.filter((child) => child !== undefined && child !== null))
  return node
}

const isHttpUrl = (value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol)
  } catch {
    return false
  }
}

const userKey = () => state.session?.user?.id ?? state.session?.user?.email

function readDetails() {
  const values = {}
  for (const [key, value] of new FormData(detailsForm)) values[key] = String(value).trim()
  return values
}

function writeDetails(values) {
  for (const [key, value] of Object.entries(values ?? {})) {
    const input = detailsForm.elements.namedItem(key)
    if (input && "value" in input) input.value = value ?? ""
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  show("view-loading")
  state.settings = await getSettings()
  state.session = await getSession()
  if (!state.session || (state.session.apiUrl && state.session.apiUrl !== state.settings.apiUrl)) {
    state.session = undefined
    $("site-chip").hidden = true
    return show("view-signed-out")
  }
  try {
    state.session = await api.refreshIfStale(state.session)
    await Promise.all([loadResumes(), loadDetails()])
  } catch (error) {
    return handleError(error)
  }
  show("view-main")
  await Promise.all([renderAutoFill(), readTab()])
}

async function loadResumes() {
  const [resumes, { [RESUME_PREF_KEY]: preferred }] = await Promise.all([
    api.listResumes().catch(() => []),
    chrome.storage.local.get(RESUME_PREF_KEY),
  ])
  state.resumes = resumes ?? []
  const fallback = state.resumes.find((r) => r.isDefault) ?? state.resumes[0]
  state.resumeId = state.resumes.some((r) => r.id === preferred) ? preferred : (fallback?.id ?? "")
  const select = $("resume-select")
  select.replaceChildren(
    ...(state.resumes.length
      ? state.resumes.map((r) =>
          el("option", {
            value: r.id,
            textContent: `${r.title}${r.version ? ` (${r.version})` : ""}${r.isDefault ? " · default" : ""}`,
          }),
        )
      : [el("option", { value: "", textContent: "No resumes in IamCandidate" })]),
  )
  select.value = state.resumeId
  select.disabled = !state.resumes.length
}

/** Your saved details, or a first set from your IamCandidate profile. */
async function loadDetails() {
  detailsForm.reset()
  const [saved, answers] = await Promise.all([getAutofill(userKey()), getAnswers(userKey())])
  state.answers = answers
  renderAnswers()
  if (saved) return writeDetails(saved)
  const user = state.session?.user ?? {}
  const profile = await api.getProfile().catch(() => ({}))
  writeDetails({
    fullName: profile.name || user.name || "",
    email: profile.email || user.email || "",
    location: profile.location ?? "",
    currentTitle: profile.role ?? "",
    summary: profile.bio ?? "",
  })
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

/** Reads the job on the active tab. An application form usually lacks the
 * description, so the posting read earlier in this tab fills the gaps. */
async function readTab() {
  const [tab] = await chrome.tabs.query(
    pageWindowId ? { active: true, windowId: pageWindowId } : { active: true, currentWindow: true },
  )
  const changed = tab?.id !== state.tab?.id || tab?.url !== state.tab?.url
  state.tab = tab
  if (changed && !state.running) $("run-card").hidden = true
  setAlert($("main-error"), "")

  let page
  state.readable = false
  if (tab?.id && isHttpUrl(tab.url)) {
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage })
      page = result?.result
      state.readable = true
    } catch {
      // No access to this site yet: granted on the first Autofill click.
    }
  }

  const here = page?.job ?? {}
  if (page?.kind === "job" && here.description) await rememberJob(tab.id, { ...here, site: page.site })
  const earlier = here.description ? undefined : await recallJob(tab?.id)
  const role = cleanRole(here.role)
  state.job = {
    role: role || earlier?.role || "",
    company: here.company || earlier?.company || "",
    description: here.description || earlier?.description || "",
    site: page?.site || earlier?.site || hostOf(tab?.url),
  }
  renderJob()
  renderMatch()
  await showStoredReport()
}

/** The last fill in this tab (often the automatic one), unless one is running now. */
async function showStoredReport() {
  if (state.running || !state.tab?.id) return
  const report = await getReport(state.tab.id, state.tab.url)
  if (!report) return
  $("run-card").hidden = false
  renderResults(report.fields, undefined, { auto: report.auto })
}

/** "Application: Full-Stack Engineer" → "Full-Stack Engineer". */
const cleanRole = (role) =>
  String(role ?? "")
    .replace(/^(job )?application( form)?\s*(for|:|-|–)\s*/i, "")
    .replace(/^apply( now)?( for)?\s*(:|-|–)?\s*/i, "")
    .trim()

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function renderJob() {
  const { job, tab } = state
  const fillable = tab?.id && isHttpUrl(tab.url)
  const chip = $("site-chip")
  chip.textContent = hostOf(tab?.url)
  chip.title = tab?.url ?? ""
  chip.hidden = !chip.textContent

  $("job-role").textContent = job.role || (fillable ? "This page" : "Nothing to fill here")
  $("job-meta").textContent = fillable
    ? [job.company, job.site].filter(Boolean).join(" · ") ||
      (state.readable ? "No job details found on this page" : "Click Autofill to read this page")
    : "Open a job's application form to autofill it."
  $("job-mark").textContent = (job.company || job.role || job.site || "?").trim().charAt(0).toUpperCase()
  $("btn-autofill").disabled = !fillable || state.running
}

/* ------------------------------------------------------------------ */
/* Resume match                                                        */
/* ------------------------------------------------------------------ */

const currentResume = () => state.resumes.find((r) => r.id === state.resumeId)

function renderMatch() {
  const resume = currentResume()
  $("resume-edit").hidden = !resume
  $("resume-file").textContent = !resume
    ? "Add a resume in IamCandidate to see how it matches each job."
    : resume.documentId
      ? "Its file is attached when the form asks for a resume."
      : "No file saved with this resume, so you'll attach it on the form yourself."

  const result = resume ? matchResume(resume, state.job?.description) : undefined
  $("match").hidden = !result
  $("match-keywords").hidden = !result
  $("match-empty").hidden = !resume || !!result
  if (!result) {
    $("match-empty").textContent = state.job?.description
      ? "This job doesn't name skills we can compare."
      : "Open the job posting first to compare it with your resume."
    return
  }

  const { score, matched, missing } = result
  const tone = score >= 75 ? "good" : score >= 50 ? "fair" : "low"
  $("match").dataset.tone = tone
  $("match-score").textContent = String(score)
  const circumference = 2 * Math.PI * 18
  const arc = $("match-arc")
  arc.style.strokeDasharray = `${circumference}`
  arc.style.strokeDashoffset = `${circumference * (1 - score / 100)}`
  $("match-title").textContent =
    tone === "good" ? "Strong match" : tone === "fair" ? "Partial match" : "Weak match"
  const total = matched.length + missing.length
  $("match-detail").textContent = `Mentions ${matched.length} of ${total} keywords from this job`
  $("keyword-list").replaceChildren(
    ...missing.map((name) => el("li", { className: "missing", textContent: name, title: "Not on your resume" })),
    ...matched.map((name) => el("li", { className: "matched", textContent: name, title: "On your resume" })),
  )
}

/* ------------------------------------------------------------------ */
/* Autofill                                                            */
/* ------------------------------------------------------------------ */

function setSteps(steps) {
  $("run-steps").replaceChildren(
    ...steps.map(({ label, status }) =>
      el(
        "li",
        { className: `step ${status}` },
        el("span", { className: "step-icon", ariaHidden: "true" }),
        el("span", { textContent: label }),
      ),
    ),
  )
}

async function runAutofill(access) {
  const tab = state.tab
  if (!tab?.id || !isHttpUrl(tab.url) || state.running) return
  state.running = true
  renderJob()
  setAlert($("main-error"), "")
  $("run-card").hidden = false
  $("run-results").hidden = true
  $("run-title").textContent = "Autofilling this page…"

  const details = readDetails()
  await saveAutofill(userKey(), details)
  const resume = currentResume()
  const fetching = { label: "Getting your resume file", status: "active" }
  const filling = { label: "Finding the questions and filling your answers", status: "pending" }
  const steps = resume?.documentId ? [fetching, filling] : [filling]
  setSteps(steps)

  try {
    await access.catch(() => false)
    const { file, skipped } = await resumeFile(resume)
    fetching.status = file ? "done" : "skipped"
    filling.status = "active"
    setSteps(steps)

    // Application forms are often embedded in an iframe (Greenhouse, Lever…);
    // frames Chrome won't let us into are skipped.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: fillPage,
      args: [details, state.answers, { userId: userKey(), detailsKey: AUTOFILL_KEY, answersKey: ANSWERS_KEY }, file],
    })
    const fields = results.flatMap((r) => (r?.result?.fields ?? []).map((field) => ({ ...field, frameId: r.frameId })))
    await saveReport(tab.id, tab.url, fields)
    renderResults(fields, skipped)
    if (!state.readable) await readTab()
  } catch (error) {
    console.warn("IamCandidate: could not fill the page", error)
    $("run-card").hidden = true
    setAlert($("main-error"), "This page can't be filled by extensions. Allow IamCandidate to read this site and try again.")
  } finally {
    state.running = false
    renderJob()
  }
}

function renderResults(fields, note, { auto = false } = {}) {
  $("run-steps").replaceChildren()
  $("run-results").hidden = false

  if (!fields.length) {
    $("run-title").textContent = "No form questions found on this page"
    $("required-count").textContent = ""
    $("required-list").replaceChildren()
    $("required-none").hidden = true
    $("run-optional").hidden = true
    $("run-meter").style.width = "0%"
    return
  }

  const answered = (f) => f.status !== "empty"
  const required = fields.filter((f) => f.required)
  const optional = fields.filter((f) => !f.required)
  const open = required.filter((f) => !answered(f)).length
  const done = auto ? "Filled automatically" : "Done"
  $("run-title").textContent = !required.length
    ? `${done} — ${fields.filter((f) => f.status === "filled").length} questions`
    : open
      ? `${done} — ${open} required question${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you`
      : `${done} — every required question is answered`
  $("run-meter").style.width = `${required.length ? (100 * (required.length - open)) / required.length : 100}%`
  $("required-count").textContent = required.length
    ? `(${required.length - open} of ${required.length} answered)`
    : ""
  $("required-none").hidden = required.length > 0
  $("required-list").replaceChildren(...required.map(fieldRow))
  $("run-optional").hidden = !optional.length
  $("optional-count").textContent = `(${optional.filter(answered).length} of ${optional.length} answered)`
  $("optional-list").replaceChildren(...optional.map(fieldRow))
  if (note) setAlert($("main-error"), note)
}

const STATUS_TEXT = {
  filled: "Filled by IamCandidate",
  had: "Already answered",
  empty: "Needs your answer",
}

function fieldRow(field, index) {
  const button = el(
    "button",
    { type: "button", className: `field-row ${field.status}`, title: `${STATUS_TEXT[field.status]} — click to jump to it` },
    el("span", { className: "field-icon", ariaHidden: "true" }),
    el("span", { className: "field-label", textContent: field.label }),
    field.status === "empty" ? el("span", { className: "field-tag", textContent: "Answer" }) : undefined,
  )
  button.style.animationDelay = `${Math.min(index, 20) * 35}ms`
  button.addEventListener("click", async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.tab.id, frameIds: [field.frameId ?? 0] },
        func: focusField,
        args: [field.id],
      })
    } catch {
      // The page changed since; nothing to jump to.
    }
  })
  return el("li", {}, button)
}

/* ------------------------------------------------------------------ */
/* Automatic filling                                                   */
/* ------------------------------------------------------------------ */

async function renderAutoFill() {
  const [on, access] = await Promise.all([getAutoFill(), chrome.permissions.contains(SITE_ACCESS)])
  const toggle = $("auto-toggle")
  toggle.checked = on && access
  $("auto-hint").textContent = !toggle.checked
    ? "Off. Click Autofill on each form yourself."
    : "Application forms are filled as soon as they open. Nothing is ever submitted."
}

/* ------------------------------------------------------------------ */
/* Saved answers                                                       */
/* ------------------------------------------------------------------ */

function renderAnswers() {
  const entries = Object.entries(state.answers).sort(([, a], [, b]) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
  $("answers-count").textContent = entries.length ? `· ${entries.length}` : ""
  $("answers-empty").hidden = entries.length > 0
  $("answers-list").replaceChildren(
    ...entries.map(([question, answer]) => {
      const text = el(
        "div",
        { className: "answer-text" },
        el("p", { className: "strong", textContent: answer.label, title: answer.label }),
        el("p", { className: "muted", textContent: answer.value, title: answer.value }),
      )
      const remove = el("button", {
        type: "button",
        className: "icon-btn",
        textContent: "×",
        title: "Forget this answer",
      })
      remove.setAttribute("aria-label", `Forget the answer to “${answer.label}”`)
      remove.addEventListener("click", async () => {
        delete state.answers[question]
        renderAnswers()
        await saveAnswers(userKey(), state.answers)
      })
      return el("li", {}, text, remove)
    }),
  )
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

function setTab(name) {
  $("tab-autofill").setAttribute("aria-selected", String(name === "autofill"))
  $("tab-details").setAttribute("aria-selected", String(name === "details"))
  $("pane-autofill").hidden = name !== "autofill"
  detailsForm.hidden = name !== "details"
}

function handleError(error) {
  console.error("iamcandidate:", error)
  if (error instanceof ApiError && error.status === 401) {
    state.session = undefined
    return show("view-signed-out")
  }
  show("view-main")
  setAlert($("main-error"), error instanceof Error ? error.message : String(error))
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

let detailsTimer
let readTimer
/** Tabs fire several updates per navigation; read the page once it settles. */
function scheduleRead() {
  clearTimeout(readTimer)
  readTimer = setTimeout(() => {
    if (state.session) void readTab()
  }, 300)
}

function wireEvents() {
  $("tab-autofill").addEventListener("click", () => setTab("autofill"))
  $("tab-details").addEventListener("click", () => setTab("details"))
  $("btn-refresh").addEventListener("click", () => (state.session ? readTab() : init()))

  $("btn-autofill").addEventListener("click", () => {
    // Before any await: Chrome only asks for permissions during a click.
    const access = chrome.permissions.request(SITE_ACCESS)
    void runAutofill(access)
  })

  $("auto-toggle").addEventListener("change", (event) => {
    const on = event.target.checked
    // Before any await: Chrome only asks for permissions during a click.
    const access = on ? chrome.permissions.request(SITE_ACCESS) : Promise.resolve(true)
    void access
      .catch(() => false)
      .then((granted) => setAutoFill(on && granted))
      .then(renderAutoFill)
  })

  $("resume-select").addEventListener("change", (event) => {
    state.resumeId = event.target.value
    void chrome.storage.local.set({ [RESUME_PREF_KEY]: state.resumeId })
    renderMatch()
  })
  $("resume-edit").addEventListener("click", () => {
    if (state.resumeId) {
      chrome.tabs.create({ url: `${state.settings.appUrl}/career/resumes/${encodeURIComponent(state.resumeId)}` })
    }
  })

  detailsForm.addEventListener("submit", (event) => event.preventDefault())
  detailsForm.addEventListener("input", () => {
    clearTimeout(detailsTimer)
    detailsTimer = setTimeout(() => saveAutofill(userKey(), readDetails()).catch(() => {}), 250)
  })

  chrome.tabs.onActivated.addListener(scheduleRead)
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === state.tab?.id && (change.status === "complete" || change.url)) scheduleRead()
  })
  chrome.windows.onFocusChanged.addListener(scheduleRead)

  chrome.storage.onChanged.addListener((changes, area) => {
    // The background worker filled this tab's form.
    if (area === "session" && state.tab?.id && changes[reportKey(state.tab.id)]?.newValue) {
      void showStoredReport()
    }
    if (area !== "local") return
    if (changes[AUTO_FILL_KEY]) void renderAutoFill()
    // Signing in or out in the popup.
    if (changes[SESSION_KEY]) {
      void init()
      return
    }
    if (!state.session) return
    // The form filler learns from the page while you type.
    if (changes[ANSWERS_KEY]) {
      const saved = changes[ANSWERS_KEY].newValue
      state.answers = saved?.userId === userKey() ? (saved.answers ?? {}) : {}
      renderAnswers()
    }
    if (changes[AUTOFILL_KEY] && document.activeElement?.form !== detailsForm) {
      const saved = changes[AUTOFILL_KEY].newValue
      if (saved?.userId === userKey()) writeDetails(saved.details)
    }
  })
}

wireEvents()
init().catch(handleError)
