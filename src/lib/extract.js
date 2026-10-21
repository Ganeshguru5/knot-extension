/**
 * Reads job or LinkedIn-profile details from the current page.
 *
 * Injected with `chrome.scripting.executeScript({ func: extractPage })`, so it
 * is serialized and runs inside the page: it must stay fully self-contained
 * (no imports, no references to anything outside this function).
 *
 * Strategy, most to least specific: site rules (LinkedIn, Naukri, Indeed,
 * Lever, Greenhouse, Ashby, Workday) → schema.org `JobPosting` JSON-LD (most
 * career sites and ATSs) → generic meta tags / `<h1>`. Anything still empty
 * is left blank for the popup to ask for.
 *
 * Returns `{ kind: "job" | "profile" | "unknown", site, url, job, profile }`.
 */
export function extractPage() {
  const url = location.href
  const host = location.hostname.replace(/^www\./, "")
  const path = location.pathname
  const params = new URLSearchParams(location.search)

  /* ---------------- helpers ---------------- */

  const clean = (value) =>
    String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim()

  const text = (el) => clean(el?.textContent)

  /** Visible text of the first element matching any selector. */
  const pick = (selectors, root = document) => {
    for (const selector of selectors) {
      let els
      try {
        els = root.querySelectorAll(selector)
      } catch {
        continue
      }
      for (const el of els) {
        const value = text(el)
        if (value) return value
      }
    }
    return ""
  }

  /** Multi-line text (keeps paragraphs) for descriptions. */
  const block = (selectors) => {
    for (const selector of selectors) {
      let el
      try {
        el = document.querySelector(selector)
      } catch {
        continue
      }
      const value = (el?.innerText ?? el?.textContent ?? "")
        .replace(/ /g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
      if (value.length > 40) return value
    }
    return ""
  }

  const meta = (name) =>
    clean(
      document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute(
        "content",
      ),
    )

  const htmlToText = (html) => {
    const withBreaks = String(html ?? "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|ul|ol|section)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
    const decoder = document.createElement("textarea")
    decoder.innerHTML = withBreaks
    return decoder.value
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  /** "remote" | "hybrid" | "onsite" | "" from a short label (not free text). */
  const workModeFrom = (value) => {
    const s = String(value ?? "").toLowerCase()
    if (!s) return ""
    if (/\bhybrid\b/.test(s)) return "hybrid"
    if (/\bremote\b|work from home|\bwfh\b|telecommute/.test(s)) return "remote"
    if (/on-?site|in[- ]office|work from office|\bwfo\b/.test(s)) return "onsite"
    return ""
  }

  const looksLikeSalary = (value) =>
    /[₹$€£]|\b(lpa|lakh|lakhs|lacs|crore|inr|usd|eur|gbp|ctc)\b|\/\s?(yr|year|hr|hour|mo|month)\b|\d+\s?k\b/i.test(
      value,
    )

  const empty = () => ({
    role: "",
    company: "",
    location: "",
    workMode: "",
    salary: "",
    jobId: "",
    jobUrl: "",
    source: "",
    description: "",
  })

  /** Fills only the fields of `target` that are still empty. */
  const fill = (target, values) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!target[key] && value) target[key] = typeof value === "string" ? value.trim() : value
    }
    return target
  }

  /* ---------------- JSON-LD JobPosting ---------------- */

  const findJobPosting = () => {
    const found = []
    const visit = (node) => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) return node.forEach(visit)
      const type = node["@type"]
      if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) {
        found.push(node)
      }
      if (node["@graph"]) visit(node["@graph"])
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        visit(JSON.parse(script.textContent))
      } catch {
        // Ignore malformed blocks.
      }
    }
    return found[0]
  }

  const fromJsonLd = (posting) => {
    if (!posting) return {}
    const first = (v) => (Array.isArray(v) ? v[0] : v)
    const org = first(posting.hiringOrganization)
    const places = [].concat(posting.jobLocation ?? [])
    const location = places
      .map((place) => {
        const address = place?.address ?? {}
        if (typeof address === "string") return address
        const country =
          typeof address.addressCountry === "object"
            ? address.addressCountry?.name
            : address.addressCountry
        return [address.addressLocality, address.addressRegion, country]
          .filter(Boolean)
          .join(", ")
      })
      .filter(Boolean)
      .slice(0, 3)
      .join(" · ")

    let salary = ""
    const pay = first(posting.baseSalary) ?? first(posting.estimatedSalary)
    if (pay && typeof pay === "object") {
      const value = pay.value ?? {}
      const currency = pay.currency ?? value.currency ?? ""
      const unit = (value.unitText ?? pay.unitText ?? "").toLowerCase()
      const amount =
        typeof value === "object"
          ? value.minValue && value.maxValue
            ? `${value.minValue}–${value.maxValue}`
            : (value.value ?? value.minValue ?? value.maxValue ?? "")
          : value
      if (amount) salary = clean(`${currency} ${amount}${unit ? ` / ${unit}` : ""}`)
    }

    const types = [].concat(posting.jobLocationType ?? []).join(" ")
    const identifier = first(posting.identifier)
    return {
      role: clean(posting.title),
      company: clean(typeof org === "string" ? org : org?.name),
      location,
      workMode: /telecommute/i.test(types) ? "remote" : "",
      salary,
      jobId: clean(typeof identifier === "object" ? identifier?.value : identifier),
      description: htmlToText(posting.description),
    }
  }

  /* ---------------- LinkedIn ---------------- */

  const linkedInProfile = () => {
    const slug = path.match(/^\/in\/([^/]+)/)?.[1]
    const name =
      pick(["main h1", "h1.text-heading-xlarge", ".pv-top-card h1", "h1"]) ||
      clean(document.title.replace(/^\(\d+\)\s*/, "").split("|")[0])
    const headline = pick([
      "main .pv-text-details__left-panel .text-body-medium",
      "main .text-body-medium.break-words",
      ".pv-top-card .text-body-medium",
    ])
    const location = pick([
      "main .pv-text-details__left-panel .text-body-small.inline",
      "main .text-body-small.inline.t-black--light.break-words",
      ".pv-top-card .text-body-small.inline",
    ])

    // The top card has "Current company: <name>. Click to skip to experience card".
    let company = ""
    for (const el of document.querySelectorAll('[aria-label^="Current company"]')) {
      const label = el.getAttribute("aria-label") ?? ""
      company = clean(label.replace(/^Current company:\s*/i, "").replace(/\.\s*Click.*$/i, ""))
      if (company) break
    }
    if (!company) {
      company = pick([
        "main .pv-text-details__right-panel-item-text",
        'main [data-field="experience_company_logo"] span[aria-hidden="true"]',
      ])
    }
    if (!company && headline) {
      company = clean(headline.match(/(?:\bat\b|@)\s+([^|,•·]+)/i)?.[1])
    }

    return {
      name,
      headline,
      location,
      company,
      linkedin: slug ? `https://www.linkedin.com/in/${decodeURIComponent(slug)}/` : url,
    }
  }

  const linkedInJob = () => {
    const id =
      params.get("currentJobId") ||
      path.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] ||
      ""
    // The details pane on search pages, the main column on /jobs/view.
    const pane =
      document.querySelector(
        ".jobs-search__job-details--container, .jobs-search__job-details, .job-view-layout, .jobs-details",
      ) ?? document

    const job = empty()
    job.source = "LinkedIn"
    job.jobId = id
    job.jobUrl = id ? `https://www.linkedin.com/jobs/view/${id}/` : url

    job.role = pick(
      [
        ".job-details-jobs-unified-top-card__job-title h1",
        ".job-details-jobs-unified-top-card__job-title",
        ".jobs-unified-top-card__job-title",
        ".jobs-details-top-card__job-title",
        "h1.top-card-layout__title",
        ".topcard__title",
        "h1",
      ],
      pane,
    )
    job.company = pick(
      [
        ".job-details-jobs-unified-top-card__company-name a",
        ".job-details-jobs-unified-top-card__company-name",
        ".jobs-unified-top-card__company-name a",
        ".jobs-unified-top-card__company-name",
        "a.topcard__org-name-link",
        ".topcard__org-name-link",
        'a[href*="/company/"]:not([aria-hidden="true"])',
      ],
      pane,
    )

    const subline = pick(
      [
        ".job-details-jobs-unified-top-card__tertiary-description-container",
        ".job-details-jobs-unified-top-card__primary-description-container",
        ".job-details-jobs-unified-top-card__primary-description",
        ".jobs-unified-top-card__subtitle-primary-grouping",
        ".topcard__flavor-row",
      ],
      pane,
    )
    job.location =
      pick([".jobs-unified-top-card__bullet", ".topcard__flavor--bullet"], pane) ||
      clean(subline.split("·")[0])

    // Preference pills: "Remote", "Full-time", "₹20L/yr - ₹30L/yr", …
    const pills = [
      ...pane.querySelectorAll(
        ".job-details-preferences-and-skills__pill, .job-details-fit-level-preferences button, .jobs-unified-top-card__workplace-type, .job-details-jobs-unified-top-card__job-insight, .ui-label",
      ),
    ].map(text)
    for (const pill of pills) {
      if (!job.workMode) job.workMode = workModeFrom(pill)
      if (!job.salary && looksLikeSalary(pill) && pill.length < 80) job.salary = pill
    }
    if (!job.workMode) job.workMode = workModeFrom(job.location)
    if (/^\s*(remote|hybrid|on-?site)\s*$/i.test(job.location)) job.location = ""
    job.location = clean(job.location.replace(/\((remote|hybrid|on-?site)\)/i, ""))

    job.description = block([
      "#job-details",
      ".jobs-description__content .jobs-box__html-content",
      ".jobs-description-content__text",
      ".jobs-description__content",
      ".show-more-less-html__markup",
      ".description__text",
    ]).replace(/^About the job\s*/i, "")

    // /jobs/view titles read "Role | Company | LinkedIn"; guest pages use
    // og:title "Company hiring Role in Location | LinkedIn".
    if (path.startsWith("/jobs/view")) {
      const parts = document.title.replace(/^\(\d+\)\s*/, "").split(" | ")
      if (parts.length >= 3) fill(job, { role: parts[0], company: parts[1] })
    }
    const og = meta("og:title").match(/^(.+?) hiring (.+?) in (.+?) \| LinkedIn/i)
    if (og) fill(job, { company: og[1], role: og[2], location: og[3] })

    return job
  }

  /* ---------------- Naukri ---------------- */

  const naukriJob = () => {
    const job = empty()
    job.source = "Naukri"
    job.jobUrl = url.split("?")[0]
    job.jobId = path.match(/-(\d{6,})\/?$/)?.[1] ?? ""
    job.role = pick(['[class*="jd-header-title"]', ".jd-header-title", "h1"])
    job.company = pick([
      '[class*="jd-header-comp-name"] > a',
      '[class*="jd-header-comp-name"] a',
      '[class*="jd-header-comp-name"]',
    ])
    job.location = pick(['[class*="jhc__location"]', '[class*="jhc__loc"]', '[class*="location"]'])
    const salary = pick(['[class*="jhc__salary"]', '[class*="salary"]'])
    if (salary && !/not disclosed/i.test(salary)) job.salary = salary
    job.workMode =
      workModeFrom(pick(['[class*="jhc__wfhmode"]', '[class*="wfh"]'])) ||
      workModeFrom(job.location)
    job.location = clean(job.location.replace(/^(hybrid|remote|on-?site)\s*-\s*/i, ""))
    job.description = block([
      '[class*="JDC__dang-inner-html"]',
      '[class*="dang-inner-html"]',
      '[class*="job-desc"]',
      ".job-desc",
    ])
    return job
  }

  /* ---------------- Other job boards / ATSs ---------------- */

  const indeedJob = () => {
    const job = empty()
    job.source = "Indeed"
    const id = params.get("vjk") || params.get("jk") || ""
    job.jobId = id
    job.jobUrl = id ? `${location.origin}/viewjob?jk=${id}` : url
    job.role = pick([
      '[data-testid="jobsearch-JobInfoHeader-title"]',
      "h1.jobsearch-JobInfoHeader-title",
      "h2.jobsearch-JobInfoHeader-title",
    ]).replace(/\s*-\s*job post$/i, "")
    job.company = pick([
      '[data-testid="inlineHeader-companyName"]',
      '[data-company-name="true"]',
      ".jobsearch-CompanyInfoContainer a",
    ])
    job.location = pick([
      '[data-testid="inlineHeader-companyLocation"]',
      '[data-testid="job-location"]',
      '[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
    ])
    job.salary = pick(['#salaryInfoAndJobType [class*="salary"]', "#salaryInfoAndJobType span"])
    job.workMode = workModeFrom(job.location)
    job.description = block(["#jobDescriptionText"])
    return job
  }

  /** Company from the first path segment, e.g. jobs.lever.co/acme/… → "Acme". */
  const companyFromPath = () => {
    const segment = path.split("/").filter(Boolean)[0] ?? ""
    return segment
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim()
  }

  const leverJob = () => {
    const job = empty()
    job.source = "Lever"
    job.jobUrl = url.replace(/\/apply\/?$/, "")
    job.jobId = path.split("/").filter(Boolean)[1] ?? ""
    job.role = pick([".posting-headline h2", "h2"])
    job.location = pick([".posting-categories .location", ".location"])
    job.workMode = workModeFrom(pick([".posting-categories .workplaceTypes", ".workplaceTypes"]))
    job.description = block([".section-wrapper.page-full-width", '[data-qa="job-description"]'])
    job.company =
      clean(meta("og:title").split(" - ")[0]) ||
      clean(document.title.split(" - ")[0]) ||
      companyFromPath()
    return job
  }

  const greenhouseJob = () => {
    const job = empty()
    job.source = "Greenhouse"
    job.jobUrl = url.split("#")[0]
    job.jobId = path.match(/\/jobs\/(\d+)/)?.[1] ?? params.get("gh_jid") ?? ""
    job.role = pick([".job__title h1", ".app-title", "h1"])
    job.location = pick([".job__location", ".location"])
    job.company = pick([".company-name"]).replace(/^at\s+/i, "") || companyFromPath()
    job.description = block([".job__description", "#content"])
    return job
  }

  const ashbyJob = () => {
    const job = empty()
    job.source = "Ashby"
    job.jobUrl = url.replace(/\/application\/?$/, "")
    job.jobId = path.split("/").filter(Boolean)[1] ?? ""
    job.role = pick(['[class*="_title_"]', "h1"])
    job.company = companyFromPath()
    return job
  }

  const workdayJob = () => {
    const job = empty()
    job.source = "Workday"
    job.jobUrl = url.split("?")[0]
    job.role = pick(['[data-automation-id="jobPostingHeader"]', "h2", "h1"])
    job.location = pick(['[data-automation-id="locations"] dd', '[data-automation-id="locations"]'])
      .replace(/^locations\s*/i, "")
    job.workMode = workModeFrom(
      pick(['[data-automation-id="remoteType"] dd', '[data-automation-id="remoteType"]']),
    )
    job.jobId = pick([
      '[data-automation-id="requisitionId"] dd',
      '[data-automation-id="requisitionId"]',
    ]).replace(/^job requisition id\s*/i, "")
    job.description = block(['[data-automation-id="jobPostingDescription"]'])
    // Tenant subdomain: acme.wd5.myworkdayjobs.com → "Acme".
    job.company = clean(location.hostname.split(".")[0]).replace(/\b\w/g, (c) => c.toUpperCase())
    return job
  }

  /* ---------------- detect ---------------- */

  const site = host.endsWith("linkedin.com")
    ? "LinkedIn"
    : host.endsWith("naukri.com")
      ? "Naukri"
      : /(^|\.)indeed\./.test(host)
        ? "Indeed"
        : host.endsWith("lever.co")
          ? "Lever"
          : host.includes("greenhouse.io")
            ? "Greenhouse"
            : host.endsWith("ashbyhq.com")
              ? "Ashby"
              : host.includes("myworkdayjobs.com")
                ? "Workday"
                : ""

  if (site === "LinkedIn" && /^\/in\/[^/]+/.test(path)) {
    return { kind: "profile", site, url, profile: linkedInProfile() }
  }

  let job
  let matched = false
  if (site === "LinkedIn" && (path.startsWith("/jobs") || params.has("currentJobId"))) {
    job = linkedInJob()
    matched = true
  } else if (site === "Naukri" && /job-listings|\/job\//.test(path)) {
    job = naukriJob()
    matched = true
  } else if (site === "Indeed" && (params.has("vjk") || params.has("jk") || /viewjob/.test(path))) {
    job = indeedJob()
    matched = true
  } else if (site === "Lever" && path.split("/").filter(Boolean).length >= 2) {
    job = leverJob()
    matched = true
  } else if (site === "Greenhouse" && /\/jobs\/\d+/.test(path + location.search)) {
    job = greenhouseJob()
    matched = true
  } else if (site === "Ashby" && path.split("/").filter(Boolean).length >= 2) {
    job = ashbyJob()
    matched = true
  } else if (site === "Workday" && /\/job\//.test(path)) {
    job = workdayJob()
    matched = true
  } else {
    job = empty()
    job.jobUrl = url.split("#")[0]
    job.source = site || clean(meta("og:site_name")) || host
  }

  const posting = findJobPosting()
  fill(job, fromJsonLd(posting))

  // Generic fallbacks for career pages without structured data.
  const jobish = /\b(jobs?|careers?|positions?|openings?|vacanc(y|ies)|apply)\b/i.test(
    `${host} ${path}`,
  )
  if (matched || posting || jobish) {
    fill(job, {
      role: pick(["h1"]) || clean(meta("og:title").split(/ [|\-–] /)[0]),
      company: meta("og:site_name"),
    })
  }
  if (!job.workMode) job.workMode = workModeFrom(job.location)

  // Never send more than the API accepts.
  const cap = (value, max) => (value.length > max ? value.slice(0, max) : value)
  for (const key of ["role", "company", "location", "salary", "jobId", "source"]) {
    job[key] = cap(clean(job[key]), 200)
  }
  job.jobUrl = cap(job.jobUrl, 2048)
  job.description = cap(job.description, 20000)

  const kind = matched || posting || (jobish && job.role) ? "job" : "unknown"
  return { kind, site, url, job }
}
