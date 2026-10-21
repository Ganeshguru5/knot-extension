import { api, ApiError, ensureApiAccess } from "../lib/api.js"
import {
  APPLICATION_STATUSES,
  PRIORITIES,
  REFERRAL_STATUSES,
  RELATIONSHIPS,
  WORK_MODES,
} from "../lib/constants.js"
import { extractPage } from "../lib/extract.js"
import {
  clearDraft,
  clearSession,
  getDraft,
  getLastApplicationId,
  getSession,
  getSettings,
  saveDraft,
  saveSettings,
  setLastApplicationId,
} from "../lib/storage.js"

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  settings: undefined,
  session: undefined,
  tab: undefined,
  /** Result of `extractPage` (or a stand-in for pages we can't read). */
  page: undefined,
  /** "job" | "referral" */
  mode: "job",
  companies: [],
  contacts: [],
  applications: [],
  resumes: [],
  /** What the success view's buttons act on. */
  saved: undefined,
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id)
const jobForm = $("job-form")
const referralForm = $("referral-form")

const VIEWS = ["view-loading", "view-login", "view-settings", "view-main", "view-success"]

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view
  $("account-menu").hidden = true
}

function setAlert(el, message) {
  el.textContent = message ?? ""
  el.hidden = !message
}

function setOptions(select, options, { placeholder } = {}) {
  select.replaceChildren()
  if (placeholder !== undefined) select.append(new Option(placeholder, ""))
  for (const option of options) select.append(new Option(option.label, option.value))
}

function setDatalist(list, values) {
  list.replaceChildren(...values.map((value) => new Option(value)))
}

function field(form, name) {
  return form.elements.namedItem(name)
}

/** Field values by name, trimmed unless `raw` (drafts keep exactly what was typed). */
function readForm(form, { raw = false } = {}) {
  const values = {}
  for (const el of form.elements) {
    if (el.name) values[el.name] = raw ? el.value : el.value.trim()
  }
  return values
}

function writeForm(form, values) {
  for (const [name, value] of Object.entries(values)) {
    const el = field(form, name)
    if (el && value !== undefined && value !== null) el.value = value
  }
}

function markMissing(form, names) {
  for (const name of names) {
    const el = field(form, name)
    el?.closest(".field")?.classList.toggle("missing", !el.value.trim())
  }
}

function setBusy(button, busy, label) {
  button.disabled = busy
  if (busy) {
    button.dataset.label = button.textContent
    button.replaceChildren(Object.assign(document.createElement("span"), { className: "spinner" }))
    button.append(label ?? "Saving…")
  } else {
    button.textContent = button.dataset.label ?? button.textContent
  }
}

const norm = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[.,&()'"]/g, " ")
    .replace(
      /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc|llp|the)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()

const normUrl = (value) => {
  try {
    const url = new URL(value)
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase()
  } catch {
    return ""
  }
}

const linkedInSlug = (value) => String(value ?? "").match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase()

const isHttpUrl = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/** `YYYY-MM-DD` → ISO at local noon (keeps the day in any time zone). */
const dateToIso = (value) => (value ? new Date(`${value}T12:00:00`).toISOString() : undefined)

const companyName = (id) => state.companies.find((c) => c.id === id)?.name ?? ""

const findCompany = (name) => {
  const key = norm(name)
  return key ? state.companies.find((c) => norm(c.name) === key) : undefined
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  wireEvents()
  state.settings = await getSettings()
  state.session = await getSession()
  if (!state.session || (state.session.apiUrl && state.session.apiUrl !== state.settings.apiUrl)) {
    return showLogin()
  }
  await start()
}

function showLogin(message) {
  state.session = undefined
  $("btn-account").hidden = true
  $("site-chip").hidden = true
  $("login-server").textContent = state.settings.apiUrl
  setAlert($("login-error"), message)
  show("view-login")
  $("login-email").focus()
}

function renderAccount() {
  const user = state.session?.user ?? {}
  const initials =
    String(user.name ?? user.email ?? "?")
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  $("btn-account").textContent = initials
  $("btn-account").hidden = false
  $("account-name").textContent = user.name ?? ""
  $("account-email").textContent = user.email ?? ""
}

async function start({ keepDraft = true, mode } = {}) {
  show("view-loading")
  renderAccount()
  setAlert($("main-error"), "")

  try {
    const [page] = await Promise.all([readPage(), loadData()])
    state.page = page
  } catch (error) {
    return handleError(error)
  }

  renderSiteChip()
  fillStaticOptions()
  populateJob()
  await populateReferral()

  const draft = keepDraft ? await getDraft(state.tab?.url) : undefined
  if (draft) {
    writeForm(jobForm, draft.job ?? {})
    writeForm(referralForm, draft.referral ?? {})
  }
  refreshDerived()
  setMode(mode ?? draft?.mode ?? (state.page.kind === "profile" ? "referral" : "job"))
  show("view-main")
}

/** Runs the extractor in the active tab. Pages Chrome won't let us script
 * (chrome://, the Web Store, PDFs…) fall back to manual entry. */
async function readPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  state.tab = tab
  const url = tab?.url ?? ""
  const fallback = { kind: "unknown", site: "", url, job: { jobUrl: isHttpUrl(url) ? url : "" } }
  if (!tab?.id || !isHttpUrl(url)) return { ...fallback, blocked: true }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
    })
    return result?.result ?? fallback
  } catch (error) {
    console.warn("knot: could not read the page", error)
    return { ...fallback, blocked: true }
  }
}

async function loadData() {
  const [companies, contacts, applications, resumes] = await Promise.all([
    api.listCompanies(),
    api.listContacts(),
    api.listApplications(),
    api.listResumes().catch(() => []),
  ])
  state.companies = companies ?? []
  state.contacts = contacts ?? []
  state.applications = (applications ?? []).sort((a, b) =>
    String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)),
  )
  state.resumes = resumes ?? []
}

function renderSiteChip() {
  const { page } = state
  const chip = $("site-chip")
  let label = ""
  try {
    label = page.site || (page.url ? new URL(page.url).hostname.replace(/^www\./, "") : "")
  } catch {
    // Not a URL.
  }
  chip.textContent = label
  chip.title = page.url ?? ""
  chip.hidden = !label
}

function fillStaticOptions() {
  setOptions(field(jobForm, "workMode"), WORK_MODES, { placeholder: "Choose…" })
  setOptions(field(jobForm, "status"), APPLICATION_STATUSES)
  setOptions(field(jobForm, "priority"), PRIORITIES)
  setOptions(
    field(jobForm, "resumeId"),
    state.resumes.map((r) => ({
      value: r.id,
      label: `${r.title}${r.version ? ` (${r.version})` : ""}${r.isDefault ? " · default" : ""}`,
    })),
    { placeholder: state.resumes.length ? "None" : "No resumes in knot" },
  )
  setOptions(field(referralForm, "relationship"), RELATIONSHIPS)
  setOptions(field(referralForm, "status"), REFERRAL_STATUSES)
  setOptions(
    field(referralForm, "applicationId"),
    state.applications.map((a) => ({
      value: a.id,
      label: `${a.role} — ${companyName(a.companyId) || "Unknown company"}`,
    })),
    { placeholder: "None" },
  )
  setDatalist(
    $("company-options"),
    state.companies.map((c) => c.name),
  )
  setDatalist(
    $("contact-options"),
    state.contacts.map((c) => c.name),
  )
}

/* ------------------------------------------------------------------ */
/* Job application                                                     */
/* ------------------------------------------------------------------ */

const JOB_ASK = ["role", "company", "location", "workMode"]

function populateJob() {
  const { page } = state
  const job = page.job ?? {}
  jobForm.reset()
  writeForm(jobForm, {
    role: job.role ?? "",
    company: job.company ?? "",
    location: job.location ?? "",
    workMode: job.workMode ?? "",
    salary: job.salary ?? "",
    jobId: job.jobId ?? "",
    jobUrl: job.jobUrl ?? "",
    source: job.source ?? "",
    description: job.description ?? "",
    status: "applied",
    priority: "medium",
    resumeId: state.resumes.find((r) => r.isDefault)?.id ?? "",
    notes: "",
  })
}

function jobBanner() {
  const { page } = state
  if (page.kind === "profile") return "This is a LinkedIn profile — add the job details yourself, or switch to Referral."
  if (page.blocked) return "This page can't be read by extensions. Fill in the job details below."
  if (page.kind !== "job") return "No job posting found on this page. Fill in the details below."
  const missing = JOB_ASK.filter((name) => !field(jobForm, name).value.trim())
  const from = page.site ? `from ${page.site}` : "from this page"
  return missing.length
    ? `Read ${from}. Fill in the highlighted fields we couldn't find.`
    : `Read ${from}. Check the details and save.`
}

/** Existing application for the same posting, if any. */
function findDuplicate() {
  const { jobUrl, jobId, company } = readForm(jobForm)
  const url = normUrl(jobUrl)
  const companyId = findCompany(company)?.id
  return state.applications.find(
    (a) =>
      (url && normUrl(a.jobUrl) === url) ||
      (jobId && a.jobId === jobId && (!companyId || a.companyId === companyId)),
  )
}

function renderDuplicate() {
  const box = $("job-duplicate")
  const duplicate = findDuplicate()
  box.replaceChildren()
  box.hidden = !duplicate
  if (!duplicate) return
  const status = APPLICATION_STATUSES.find((s) => s.value === duplicate.status)?.label ?? duplicate.status
  box.append(
    `Already in knot: ${duplicate.role} at ${companyName(duplicate.companyId) || "this company"} (${status}). `,
  )
  const link = Object.assign(document.createElement("button"), {
    type: "button",
    className: "link",
    textContent: "Open it",
  })
  link.addEventListener("click", () => openApp(`/career/applications/${encodeURIComponent(duplicate.id)}`))
  box.append(link)
}

async function saveJob() {
  const values = readForm(jobForm)
  const errors = []
  if (!values.role) errors.push("role")
  if (!values.company) errors.push("company")
  if (!values.workMode) errors.push("workMode")
  if (values.jobUrl && !isHttpUrl(values.jobUrl)) errors.push("jobUrl")
  if (flagInvalid(jobForm, errors)) return

  const button = $("btn-save")
  setBusy(button, true)
  try {
    const companyId = await resolveCompany(values.company, "active")
    const input = {
      companyId,
      role: values.role,
      location: values.location,
      workMode: values.workMode,
      status: values.status,
      priority: values.priority,
      notes: values.notes,
    }
    for (const key of ["salary", "jobId", "jobUrl", "source", "description", "resumeId"]) {
      if (values[key]) input[key] = values[key]
    }
    if (values.nextFollowUp) input.nextFollowUp = dateToIso(values.nextFollowUp)

    const application = await api.createApplication(input)
    state.applications.unshift(application)
    await Promise.all([clearDraft(), setLastApplicationId(application.id)])
    state.saved = { type: "application", application }
    showSuccess(
      "Application saved",
      `${application.role} at ${companyName(companyId) || values.company}`,
    )
  } catch (error) {
    handleError(error)
  } finally {
    setBusy(button, false)
  }
}

/* ------------------------------------------------------------------ */
/* Referral                                                            */
/* ------------------------------------------------------------------ */

/** Contact already in knot: same LinkedIn profile, else same name. */
function findContact() {
  const { linkedin, name } = readForm(referralForm)
  const slug = linkedInSlug(linkedin)
  if (slug) {
    const bySlug = state.contacts.find((c) => linkedInSlug(c.linkedin) === slug)
    if (bySlug) return bySlug
  }
  const key = name.toLowerCase()
  return key ? state.contacts.find((c) => c.name.toLowerCase() === key) : undefined
}

async function populateReferral() {
  const { page } = state
  const profile = page.profile ?? {}
  const job = page.kind === "job" ? (page.job ?? {}) : {}
  referralForm.reset()
  writeForm(referralForm, {
    name: profile.name ?? "",
    headline: profile.headline ?? "",
    linkedin: profile.linkedin ?? "",
    relationship: "employee",
    company: profile.company || job.company || "",
    role: job.role ?? "",
    jobId: job.jobId ?? "",
    jobUrl: job.jobUrl ?? "",
    status: "not_contacted",
    applicationId: "",
  })

  // Link to an application: the one for this job page, else the one just saved.
  let application
  if (page.kind === "job") {
    application = findDuplicate()
  } else {
    const lastId = await getLastApplicationId()
    application = state.applications.find((a) => a.id === lastId)
  }
  if (application) applyApplication(application.id, { keepCompany: page.kind === "profile" })

  const contact = findContact()
  if (contact) applyContact(contact)
}

/** Fills role/job/company from a saved application. */
function applyApplication(id, { keepCompany = false } = {}) {
  const application = state.applications.find((a) => a.id === id)
  field(referralForm, "applicationId").value = application ? id : ""
  if (!application) return
  const company = companyName(application.companyId)
  const current = field(referralForm, "company").value.trim()
  // A profile's current employer is who refers you; only replace it when it
  // matches or is empty, otherwise the application's company wins.
  if (!keepCompany || !current || norm(current) === norm(company)) {
    field(referralForm, "company").value = company
  }
  writeForm(referralForm, {
    role: application.role,
    jobId: application.jobId ?? "",
    jobUrl: application.jobUrl ?? "",
  })
}

function applyContact(contact) {
  const values = readForm(referralForm)
  writeForm(referralForm, {
    name: contact.name,
    headline: values.headline || contact.role,
    email: values.email || contact.email,
    linkedin: values.linkedin || contact.linkedin || "",
    relationship: contact.relationship,
  })
  if (!values.company && contact.companyId) {
    field(referralForm, "company").value = companyName(contact.companyId)
  }
}

function renderContactMatch() {
  const contact = findContact()
  const box = $("contact-existing")
  box.hidden = !contact
  if (!contact) return
  box.textContent = `${contact.name} is already in your contacts — the referral will be linked to them.`
}

async function saveReferral() {
  const values = readForm(referralForm)
  const errors = []
  if (!values.name) errors.push("name")
  if (!values.company) errors.push("company")
  if (!values.role) errors.push("role")
  if (values.linkedin && !isHttpUrl(values.linkedin)) errors.push("linkedin")
  if (values.jobUrl && !isHttpUrl(values.jobUrl)) errors.push("jobUrl")
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push("email")
  if (flagInvalid(referralForm, errors)) return

  const button = $("btn-save")
  setBusy(button, true)
  try {
    const companyId = await resolveCompany(values.company, "target")

    let contact = findContact()
    if (contact) {
      // Fill in what the contact record is missing; never overwrite.
      const patch = {}
      if (!contact.linkedin && values.linkedin) patch.linkedin = values.linkedin
      if (!contact.email && values.email) patch.email = values.email
      if (!contact.companyId) patch.companyId = companyId
      if (!contact.role && values.headline) patch.role = values.headline
      if (Object.keys(patch).length) contact = await api.updateContact(contact.id, patch)
    } else {
      const input = {
        name: values.name,
        role: values.headline,
        companyId,
        email: values.email,
        relationship: values.relationship,
        notes: "",
      }
      if (values.linkedin) input.linkedin = values.linkedin
      contact = await api.createContact(input)
      state.contacts.push(contact)
    }

    const input = {
      contactId: contact.id,
      companyId,
      role: values.role,
      jobId: values.jobId,
      jobUrl: values.jobUrl,
      status: values.status,
      notes: values.notes,
    }
    if (values.requestDate) input.requestDate = dateToIso(values.requestDate)
    if (values.followUpDate) input.followUpDate = dateToIso(values.followUpDate)

    const referral = await api.createReferral(input)
    await clearDraft()
    state.saved = { type: "referral", referral }
    showSuccess("Referral added", `${contact.name} · ${values.role} at ${companyName(companyId) || values.company}`)
  } catch (error) {
    handleError(error)
  } finally {
    setBusy(button, false)
  }
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

/** Id of the company named `name`, creating it in knot when it's new. */
async function resolveCompany(name, status) {
  const existing = findCompany(name)
  if (existing) return existing.id
  const company = await api.createCompany({
    name: name.trim(),
    industry: "",
    website: "",
    location: "",
    size: "",
    status,
    description: "",
    notes: "",
  })
  state.companies.push(company)
  return company.id
}

function flagInvalid(form, names) {
  for (const el of form.querySelectorAll(".field.invalid")) el.classList.remove("invalid")
  for (const name of names) field(form, name)?.closest(".field")?.classList.add("invalid")
  if (!names.length) {
    setAlert($("main-error"), "")
    return false
  }
  field(form, names[0])?.focus()
  const labels = names.map(
    (name) => field(form, name)?.closest(".field")?.querySelector(".label")?.firstChild?.textContent?.trim() ?? name,
  )
  setAlert($("main-error"), `Check ${labels.join(", ")}.`)
  return true
}

function renderCompanyHints(form) {
  const name = field(form, "company").value.trim()
  const hint = form.querySelector('[data-hint-for="company"]')
  const existing = findCompany(name)
  hint.classList.toggle("ok", !!existing)
  hint.textContent = !name
    ? ""
    : existing
      ? `Matches “${existing.name}” in knot`
      : "New company — it will be added to knot"
}

/** Everything that depends on the current field values. */
function refreshDerived() {
  markMissing(jobForm, state.page.kind === "job" ? JOB_ASK : ["role", "company", "workMode"])
  markMissing(referralForm, ["name", "company", "role"])
  renderCompanyHints(jobForm)
  renderCompanyHints(referralForm)
  renderDuplicate()
  renderContactMatch()
  const description = field(jobForm, "description").value
  jobForm.querySelector('[data-count-for="description"]').textContent = description
    ? `· ${description.length.toLocaleString()} chars`
    : "· empty"
}

function setMode(mode) {
  state.mode = mode
  $("tab-job").setAttribute("aria-selected", String(mode === "job"))
  $("tab-referral").setAttribute("aria-selected", String(mode === "referral"))
  jobForm.hidden = mode !== "job"
  referralForm.hidden = mode !== "referral"
  $("btn-save").textContent = mode === "job" ? "Save application" : "Add referral"
  setAlert($("main-error"), "")

  const banner = $("detect-banner")
  if (mode === "job") {
    setAlert(banner, jobBanner())
  } else if (state.page.kind === "profile") {
    const missing = ["name", "company"].filter((n) => !field(referralForm, n).value.trim())
    setAlert(
      banner,
      missing.length
        ? "Read this LinkedIn profile. Fill in the highlighted fields we couldn't find."
        : "Read this LinkedIn profile. Pick the job you want a referral for.",
    )
  } else {
    setAlert(banner, "Open someone's LinkedIn profile to fill this in automatically, or enter the details below.")
  }
}

function showSuccess(title, detail) {
  $("success-title").textContent = title
  $("success-detail").textContent = detail
  $("success-referral").hidden = state.saved?.type !== "application"
  show("view-success")
}

function openApp(path) {
  chrome.tabs.create({ url: `${state.settings.appUrl}${path}` })
}

function handleError(error) {
  console.error("knot:", error)
  if (error instanceof ApiError && error.status === 401) {
    return showLogin("Your session has expired. Sign in again.")
  }
  const message = error instanceof Error ? error.message : String(error)
  if ($("view-main").hidden) {
    // Failed while loading: there's no form to show the error on.
    show("view-main")
    jobForm.hidden = true
    referralForm.hidden = true
  }
  setAlert($("main-error"), message)
}

let draftTimer
function scheduleDraftSave() {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    if (!state.tab?.url) return
    saveDraft({
      url: state.tab.url,
      mode: state.mode,
      job: readForm(jobForm, { raw: true }),
      referral: readForm(referralForm, { raw: true }),
    }).catch(() => {})
  }, 250)
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function wireEvents() {
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const email = $("login-email").value.trim()
    const password = $("login-password").value
    if (!email || !password) return setAlert($("login-error"), "Enter your email and password.")
    const apiUrl = state.settings.apiUrl
    const access = ensureApiAccess(apiUrl) // before any await: needs the gesture
    const button = $("login-submit")
    setBusy(button, true, "Signing in…")
    setAlert($("login-error"), "")
    try {
      if (!(await access)) throw new Error(`Allow access to ${apiUrl} to sign in.`)
      state.session = await api.login(apiUrl, email, password)
      $("login-password").value = ""
      await start()
    } catch (error) {
      setAlert($("login-error"), error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(button, false)
    }
  })

  const openSettings = () => {
    $("settings-api").value = state.settings.apiUrl
    $("settings-app").value = state.settings.appUrl
    setAlert($("settings-error"), "")
    show("view-settings")
  }
  $("btn-settings").addEventListener("click", openSettings)
  $("login-change-server").addEventListener("click", openSettings)
  $("settings-cancel").addEventListener("click", () => (state.session ? start() : showLogin()))

  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const apiUrl = $("settings-api").value.trim().replace(/\/+$/, "")
    const appUrl = $("settings-app").value.trim().replace(/\/+$/, "")
    if (!isHttpUrl(apiUrl) || !isHttpUrl(appUrl)) {
      return setAlert($("settings-error"), "Enter full URLs, e.g. http://localhost:3001")
    }
    const access = ensureApiAccess(apiUrl) // before any await: needs the gesture
    try {
      if (!(await access)) {
        return setAlert($("settings-error"), `knot needs permission to reach ${new URL(apiUrl).host}.`)
      }
    } catch (error) {
      return setAlert($("settings-error"), error.message)
    }
    const changedServer = apiUrl !== state.settings.apiUrl
    state.settings = await saveSettings({ apiUrl, appUrl })
    if (changedServer) {
      await clearSession()
      return showLogin()
    }
    state.session ? start() : showLogin()
  })

  $("btn-account").addEventListener("click", (event) => {
    event.stopPropagation()
    $("account-menu").hidden = !$("account-menu").hidden
  })
  document.addEventListener("click", (event) => {
    if (!$("account-menu").contains(event.target)) $("account-menu").hidden = true
  })
  $("btn-open-app").addEventListener("click", () => openApp("/dashboard"))
  $("btn-signout").addEventListener("click", async () => {
    await Promise.all([clearSession(), clearDraft()])
    showLogin()
  })

  $("tab-job").addEventListener("click", () => {
    setMode("job")
    scheduleDraftSave()
  })
  $("tab-referral").addEventListener("click", () => {
    setMode("referral")
    scheduleDraftSave()
  })

  for (const form of [jobForm, referralForm]) {
    form.addEventListener("submit", (event) => {
      event.preventDefault()
      $("btn-save").click()
    })
    form.addEventListener("input", (event) => {
      event.target.closest(".field")?.classList.remove("invalid")
      if (form === referralForm && event.target.name === "applicationId") {
        applyApplication(event.target.value)
      }
      if (form === referralForm && event.target.name === "name") {
        const contact = state.contacts.find((c) => c.name === event.target.value)
        if (contact) applyContact(contact)
      }
      refreshDerived()
      scheduleDraftSave()
    })
  }

  $("btn-save").addEventListener("click", () => (state.mode === "job" ? saveJob() : saveReferral()))
  $("btn-reread").addEventListener("click", async () => {
    await clearDraft()
    start({ keepDraft: false, mode: state.mode })
  })

  $("success-open").addEventListener("click", () => {
    const saved = state.saved
    if (saved?.type === "application") {
      openApp(`/career/applications/${encodeURIComponent(saved.application.id)}`)
    } else {
      openApp("/career/referrals")
    }
  })
  $("success-referral").addEventListener("click", () => {
    const application = state.saved?.application
    populateReferral().then(() => {
      if (application) applyApplication(application.id)
      refreshDerived()
      setMode("referral")
      show("view-main")
    })
  })
  $("success-again").addEventListener("click", () => start({ keepDraft: false, mode: state.mode }))
}

init().catch(handleError)
