/**
 * Fills a job application form on the current page from your autofill details
 * and the answers you gave on earlier forms, then learns from what you type.
 *
 * Injected with
 * `chrome.scripting.executeScript({ func: fillPage, args: [details, answers, store, resume] })`,
 * so it is serialized and runs inside the page (as a content script): it must
 * stay fully self-contained (no imports, no references to anything outside
 * this function). `store` is `{ userId, learnKey }`: the `chrome.storage.local`
 * key where it queues what it learns, for the extension to send to IamCandidate. `resume` is
 * `{ name, type, base64 }`, attached to the form's resume upload, or undefined.
 *
 * It only types into fields, picks options (radios, and the option list of a
 * searchable dropdown) and attaches your resume. It never clicks a button,
 * presses Enter, or calls `form.submit()` / `requestSubmit()`: you review the
 * form and submit it yourself. Fields that already have a value are left
 * alone, and so are passwords, checkboxes, other file uploads and sign-in forms.
 *
 * Learning: once it has run in a frame, every question you answer there is
 * saved. A field that is one of your details (phone, notice period…) fills
 * that detail if it was empty; any other question is saved as an answer,
 * keyed by its label, and filled on the next form that asks the same thing.
 * Sensitive fields (IDs, card numbers, codes) are never saved.
 *
 * Resolves to `{ fields: [{ id, label, required, status, key }], frame }` for
 * this frame: every question it found, `status` "filled" (by this run), "had"
 * (already answered) or "empty". Each field is tagged with
 * `data-iamcandidate-field="<id>"` so {@link focusField} can find it.
 *
 * `options.onlyApplications` (for filling without a click) leaves frames
 * alone unless they look like a job application: your name, an email or
 * phone, and a resume upload, a job question or a careers URL. Newsletter
 * and contact forms don't qualify. Such frames resolve to `{ fields: [],
 * application: false }`. `options.detectOnly` stops after that check.
 */
export async function fillPage(details, answers = {}, store = undefined, resume = undefined, options = {}) {
  const clean = (value) =>
    String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim()

  /* ---------------- what each field is ---------------- */

  // Most specific first: the first rule that matches a field wins.
  // `ac` is the HTML autocomplete token; `not` rules out look-alikes.
  const RULES = [
    { key: "preferredName", re: /preferred (first )?name|nick ?name/ },
    { key: "linkedin", re: /linked\s?in/ },
    { key: "github", re: /git\s?hub/ },
    // Yes/no eligibility questions; the profile holds "yes" or "no".
    { key: "needsSponsorship", re: /sponsor/ },
    { key: "workAuthorization", re: /authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (allowed|permitted|able|entitled) to work|right to work/ },
    { key: "willingToRelocate", re: /relocat/ },
    // Voluntary self-identification: filled only when you've chosen an answer.
    { key: "gender", re: /\bgender\b|\bsex\b/ },
    { key: "ethnicity", re: /ethnic|\brace\b/ },
    { key: "disability", re: /disabilit/ },
    { key: "veteran", re: /veteran/ },
    { key: "pronouns", re: /pronoun/ },
    { key: "graduationYear", re: /graduat(ion|ed)? ?(year|date)|year of (graduation|passing)|passing year/ },
    { key: "fieldOfStudy", re: /field of study|\bmajor\b|discipline|speciali[sz]ation/ },
    { key: "degree", re: /\bdegree\b|qualification/, not: /year/ },
    { key: "school", re: /\bschool\b|universit|college|institut/, not: /high school|year/ },
    { key: "postalCode", ac: ["postal-code"], re: /\bzip\b|postal|post ?code|pin ?code/ },
    { key: "addressLine", ac: ["street-address", "address-line1"], re: /street|address line|^address\b/, not: /e-?mail|ip address|web/ },
    { key: "state", ac: ["address-level1"], re: /^state\b|\bstate\/|province|^region\b/ },
    { key: "country", ac: ["country", "country-name"], re: /\bcountry\b/, not: /code|location|city/ },
    { key: "portfolio", re: /portfolio|personal (web)?site|website|blog|\burl\b/, not: /linkedin|github|company/ },
    { key: "email", ac: ["email"], re: /e-?mail/ },
    { key: "phone", ac: ["tel", "tel-national"], re: /phone|mobile|\bcell\b|contact (number|no)|\btel\b/, not: /country|code|ext(ension)?\b|type/ },
    { key: "firstName", ac: ["given-name"], re: /first.?name|given.?name|\bfname\b|forename/ },
    { key: "lastName", ac: ["family-name"], re: /last.?name|surname|family.?name|\blname\b/ },
    { key: "fullName", ac: ["name"], re: /full.?name|^name\b|your name|legal name|candidate name|applicant name/, not: /company|employer|school|college|university|user|refer|manager|emergency|middle|preferred/ },
    { key: "noticePeriod", re: /notice period|how soon|earliest (start|joining)|availability to join/ },
    { key: "expectedSalary", re: /expected (ctc|salary|compensation|pay)|salary expectation|desired (salary|compensation)/ },
    { key: "currentSalary", re: /current (ctc|salary|compensation|pay)/ },
    { key: "experienceYears", re: /years? of (relevant |total |professional )?experience|total experience|experience \(?(in )?years/ },
    { key: "currentTitle", ac: ["organization-title"], re: /(current|present|latest) (job )?(title|role|position|designation)|^job title|^designation/ },
    { key: "currentCompany", ac: ["organization"], re: /(current|present|latest) (company|employer|organi[sz]ation)|^company( name)?$|^employer/ },
    { key: "location", ac: ["address-level2"], re: /\bcity\b|current location|^location|where .*(based|located)|town/, not: /preferred|relocat|willing/ },
    { key: "coverLetter", textarea: true, re: /cover letter/ },
    { key: "summary", textarea: true, re: /summary|about (you|yourself)|introduce yourself|tell us about/ },
  ]

  // Never saved, whatever the form asks.
  const SENSITIVE =
    /gender|\bsex\b|ethnic|\brace\b|disabilit|veteran|password|passcode|\bpin\b|\bssn\b|social security|card (number|no)|credit card|debit card|\bcvv\b|\bcvc\b|expiry|iban|swift|routing|account (number|no)|aadhaa?r|\bpan\b|passport|national id|date of birth|\bdob\b|birth ?date|\botp\b|one.time|verification code|captcha|security (question|answer)/

  const textOf = (el) => clean(el?.innerText ?? el?.textContent)

  /** A label's own text, without the options of a <select> nested inside it. */
  const labelText = (label) => {
    if (!label.querySelector("input, select, textarea")) return textOf(label)
    const copy = label.cloneNode(true)
    for (const control of copy.querySelectorAll("input, select, textarea")) control.remove()
    return clean(copy.textContent)
  }

  /** The visible question for a field: its <label>, aria labels, or the text just before it. */
  const labelOf = (el) => {
    const parts = []
    if (el.labels?.length) parts.push(...[...el.labels].map(labelText))
    const ids = el.getAttribute("aria-labelledby")
    if (ids) {
      for (const id of ids.split(/\s+/)) parts.push(textOf(document.getElementById(id)))
    }
    parts.push(el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.title)
    let label = clean(parts.filter(Boolean).join(" "))
    if (!label) {
      // ATS widgets often put the question in a sibling block above the input.
      let node = el
      for (let depth = 0; depth < 4 && node && !label; depth++) {
        let prev = node.previousElementSibling
        while (prev && !label) {
          label = textOf(prev).slice(0, 120)
          prev = prev.previousElementSibling
        }
        node = node.parentElement
      }
    }
    return label
  }

  /** A radio group's question: its <legend>, or the radiogroup's aria label. */
  const groupOf = (radio) => radio.closest('fieldset, [role="radiogroup"]')
  const groupLabelOf = (radio) => {
    const group = groupOf(radio)
    if (!group) return ""
    const legend = group.tagName === "FIELDSET" ? group.querySelector("legend") : undefined
    if (legend) return textOf(legend)
    const ids = group.getAttribute("aria-labelledby")
    if (ids) return clean(ids.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(" "))
    return clean(group.getAttribute("aria-label"))
  }
  const optionLabelOf = (radio) =>
    clean(radio.labels?.length ? labelText(radio.labels[0]) : radio.getAttribute("aria-label") || radio.value)

  /** Saved answers are looked up by the question with its punctuation and "required" marks removed. */
  const questionKey = (label) =>
    clean(label)
      .toLowerCase()
      .replace(/\((required|optional)\)|\brequired\b/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()

  const describe = (el) =>
    [
      labelOf(el),
      el.name,
      el.id,
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-qa"),
      el.getAttribute("data-testid"),
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_\-[\]]+/g, " ")
      .toLowerCase()

  const keyFor = (el) => {
    const tokens = String(el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/)
    for (const rule of RULES) {
      if (rule.ac?.some((token) => tokens.includes(token))) return rule.key
    }
    const label = clean(labelOf(el)).toLowerCase()
    const all = describe(el)
    const isTextarea = el.tagName === "TEXTAREA"
    for (const rule of RULES) {
      if (rule.textarea && !isTextarea) continue
      // The visible label is the best signal; fall back to name/id/test ids.
      const hay = rule.re.test(label) ? label : rule.re.test(all) ? all : ""
      if (!hay) continue
      if (rule.not?.test(hay)) continue
      return rule.key
    }
    return undefined
  }

  /** The detail a question asks for, from its text alone (radio groups have no single field). */
  const keyForText = (text) => {
    const label = clean(text).toLowerCase()
    const rule = RULES.find((r) => !r.textarea && r.re.test(label) && !r.not?.test(label))
    return rule?.key
  }

  /* ---------------- values ---------------- */

  const name = clean(details.fullName)
  const [first = "", ...rest] = name.split(" ")
  const values = {
    ...details,
    fullName: name || clean(`${details.firstName ?? ""} ${details.lastName ?? ""}`),
    firstName: clean(details.firstName) || first,
    lastName: clean(details.lastName) || rest.join(" "),
    location: clean(details.location) || clean(details.city),
  }
  const savedAnswer = (label) => answers?.[questionKey(label)]?.value

  /* ---------------- writing ---------------- */

  const SKIP_TYPES = new Set([
    "hidden", "password", "file", "checkbox", "radio", "submit", "button",
    "reset", "image", "search", "range", "color", "date", "datetime-local", "month", "week", "time",
  ])

  /** A text box that opens a list of options as you type (location, pronouns…). */
  const isCombobox = (el) =>
    el.tagName === "INPUT" &&
    (el.getAttribute("role") === "combobox" ||
      /list|both/.test(el.getAttribute("aria-autocomplete") ?? "") ||
      el.getAttribute("aria-haspopup") === "listbox")

  /** Fields we fill and learn from (radios are handled as groups). */
  const usable = (el) => {
    if (el.disabled || el.readOnly) return false
    const type = (el.type || "text").toLowerCase()
    if (el.tagName === "INPUT" && SKIP_TYPES.has(type) && !(type === "search" && isCombobox(el))) return false
    // Sign-in and sign-up forms aren't applications.
    return !el.form?.querySelector('input[type="password"]')
  }

  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden") return false
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** React, Vue and Angular track the value through the prototype setter, so
   * set it there and announce it with the events they listen to. No key events:
   * an Enter could submit the form. */
  const setValue = (el, value, { blur = true } = {}) => {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    if (blur) el.dispatchEvent(new FocusEvent("blur"))
  }

  /** Mouse events in the order a real click sends them; dropdown libraries
   * often pick an option on mousedown, not click. */
  const press = (target) => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = type.startsWith("pointer") && globalThis.PointerEvent ? PointerEvent : MouseEvent
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }))
    }
    target.click()
  }

  /** The options a combobox is showing: its own listbox, or any open one. */
  const optionsFor = (el) => {
    const ids = `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`
      .split(/\s+/)
      .filter(Boolean)
    const own = ids.map((id) => document.getElementById(id)).filter(Boolean)
    const lists = own.length ? own : [...document.querySelectorAll('[role="listbox"]')].filter(visible)
    return lists
      .flatMap((list) => [...list.querySelectorAll('[role="option"]')])
      .filter((option) => visible(option) && option.getAttribute("aria-disabled") !== "true")
  }

  const bestOption = (options, value) => {
    const want = clean(value).toLowerCase()
    const text = (option) => textOf(option).toLowerCase()
    return (
      options.find((o) => text(o) === want) ??
      options.find((o) => text(o).startsWith(want)) ??
      options.find((o) => {
        const label = text(o)
        return label.length > 1 && (label.includes(want) || want.includes(label))
      })
    )
  }

  /** Types into a combobox and picks the matching option. When nothing
   * matches, the text is cleared again: a half-typed search isn't an answer. */
  const pickOption = async (el, value) => {
    el.focus()
    press(el)
    setValue(el, value, { blur: false })
    for (let waited = 0; waited < 2000; waited += 100) {
      await sleep(100)
      const option = bestOption(optionsFor(el), value)
      if (option) {
        press(option)
        await sleep(150)
        el.dispatchEvent(new FocusEvent("blur"))
        return true
      }
    }
    setValue(el, "")
    return false
  }

  /** The option whose text or value matches, e.g. "India" in a country list. */
  /** "no" matches "No, I don't", not "Not a veteran". */
  const startsWithWord = (label, want) =>
    label.startsWith(want) && !/[\p{L}\p{N}]/u.test(label.charAt(want.length))

  /** A radio option for an answer: exact, then at the start, then anywhere for longer answers. */
  const choiceMatches = (label, want) =>
    label === want || startsWithWord(label, want) || (want.length > 3 && label.includes(want))

  const matchOption = (select, value) => {
    const want = clean(value).toLowerCase()
    if (!want) return undefined
    const options = [...select.options].filter((o) => !o.disabled && o.value !== "")
    return (
      options.find((o) => clean(o.textContent).toLowerCase() === want || o.value.toLowerCase() === want) ??
      options.find((o) => startsWithWord(clean(o.textContent).toLowerCase(), want)) ??
      options.find((o) => {
        const label = clean(o.textContent).toLowerCase()
        return label.length > 1 && (want.includes(label) || label.includes(want))
      })
    )
  }

  const mark = (el) => {
    const previous = el.style.outline
    el.style.outline = "2px solid oklch(0.62 0.17 155)"
    el.style.outlineOffset = "1px"
    el.addEventListener("input", () => (el.style.outline = previous), { once: true })
  }

  /* ---------------- what was asked, and how it went ---------------- */

  const fields = []
  const run = Math.random().toString(36).slice(2, 8)
  const shown = (label) =>
    clean(label)
      .replace(/\((required|optional)\)/gi, "")
      .replace(/[\s*]+$/, "")
      .slice(0, 120)
  const requiredOf = (el, label) =>
    el.required ||
    el.getAttribute("aria-required") === "true" ||
    !!el.closest('[aria-required="true"]') ||
    /\*/.test(label)
  const track = (el, label, required, status, key) => {
    const id = `${run}-${fields.length}`
    el.setAttribute("data-iamcandidate-field", id)
    fields.push({ id, label: shown(label) || "Untitled question", required, status, key })
  }
  // Custom-styled radios and checkboxes hide the input and show its label.
  const onPage = (el) => visible(el) || [...(el.labels ?? [])].some(visible)
  const fold = (text) =>
    String(text ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()

  /* ---------------- resume ---------------- */

  const uploads = [...document.querySelectorAll('input[type="file"]')].filter(
    (input) => !input.disabled && !input.form?.querySelector('input[type="password"]'),
  )
  const aboutUpload = (input) =>
    fold(
      [labelOf(input), input.name, input.id, input.getAttribute("data-qa"), input.getAttribute("data-testid")]
        .filter(Boolean)
        .join(" "),
    )
  const resumeInput =
    uploads.find((input) => /resume|\bcv\b|curriculum/.test(aboutUpload(input)) && !/cover/.test(aboutUpload(input))) ??
    uploads.find(
      (input) =>
        !/cover|photo|picture|image|avatar|transcript|certificate/.test(aboutUpload(input)) &&
        (!input.accept || /pdf|doc/.test(input.accept)),
    )

  /* ---------------- is this a job application? ---------------- */

  if (options.onlyApplications || options.detectOnly) {
    const JOB_KEYS = new Set([
      "linkedin", "github", "portfolio", "noticePeriod", "expectedSalary", "currentSalary",
      "experienceYears", "currentTitle", "currentCompany", "coverLetter",
    ])
    const asked = new Set()
    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (!usable(el) || !visible(el)) continue
      const key = keyFor(el)
      if (key) asked.add(/name$/i.test(key) ? "name" : key)
    }
    const namedResume = uploads.some((input) => /resume|\bcv\b|curriculum/.test(aboutUpload(input)))
    const jobish =
      namedResume ||
      [...asked].some((key) => JOB_KEYS.has(key)) ||
      /\b(apply|application|careers?|jobs?)\b/i.test(`${location.href} ${document.title}`)
    const application = asked.has("name") && (asked.has("email") || asked.has("phone")) && jobish
    if (!application || options.detectOnly) return { fields: [], application, frame: location.hostname }
  }

  let attached = false
  if (resume?.base64 && resumeInput && !resumeInput.files?.length) {
    try {
      const bytes = Uint8Array.from(atob(resume.base64), (c) => c.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], resume.name, { type: resume.type }))
      resumeInput.files = transfer.files
      resumeInput.dispatchEvent(new Event("input", { bubbles: true }))
      resumeInput.dispatchEvent(new Event("change", { bubbles: true }))
      attached = true
      // Many ATSs read the resume and fill fields from it; let that start first.
      await sleep(1500)
    } catch {
      // The site rejected a programmatic file; it's listed for you to attach.
    }
  }

  /* ---------------- filling, in page order ---------------- */

  const groups = new Set()
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const type = (el.type || "").toLowerCase()

    if (el.tagName === "INPUT" && type === "file") {
      if (!uploads.includes(el)) continue
      let label = labelOf(el)
      if (!label || /^(drop|select|browse|upload|attach|choose)\b/i.test(label)) {
        label = el === resumeInput ? "Resume" : "File upload"
      }
      const status = el === resumeInput && attached ? "filled" : el.files?.length ? "had" : "empty"
      track(el, label, requiredOf(el, label), status, el === resumeInput ? "resume" : undefined)
      continue
    }

    // Yes/no and multiple-choice questions you answered before.
    if (el.tagName === "INPUT" && type === "radio") {
      const group = groupOf(el)
      if (!group || groups.has(group)) continue
      groups.add(group)
      const options = [...group.querySelectorAll('input[type="radio"]')].filter((r) => !r.disabled && onPage(r))
      if (!options.length) continue
      const label = groupLabelOf(el)
      const required =
        options.some((r) => r.required) || group.getAttribute("aria-required") === "true" || /\*/.test(label)
      if (options.some((r) => r.checked)) {
        track(options[0], label, required, "had")
        continue
      }
      const detail = keyForText(label)
      const want = (clean(detail ? values[detail] : "") || clean(savedAnswer(label))).toLowerCase()
      const choice = want && options.find((r) => choiceMatches(optionLabelOf(r).toLowerCase(), want))
      if (choice) {
        // A radio can't submit a form; clicking it is how frameworks expect it to change.
        choice.click()
        mark(choice.labels?.[0] ?? choice)
      }
      track(options[0], label, required, choice ? "filled" : "empty", detail && values[detail] ? detail : choice ? "answer" : detail)
      continue
    }

    // Consent boxes are yours to tick; required ones are listed so you don't miss them.
    if (el.tagName === "INPUT" && type === "checkbox") {
      if (el.disabled || !onPage(el) || groupOf(el)) continue
      const label = el.labels?.length ? labelText(el.labels[0]) : labelOf(el)
      if (requiredOf(el, label)) track(el, label, true, el.checked ? "had" : "empty")
      continue
    }

    if (!usable(el) || !visible(el)) continue

    const key = keyFor(el)
    const label = labelOf(el)
    const required = requiredOf(el, label)
    const had = el.tagName === "SELECT" ? !!el.value && el.selectedIndex > 0 : !!el.value.trim()
    if (had) {
      track(el, label, required, "had", key)
      continue
    }

    let value = clean(key ? values[key] : "")
    let raw = key === "summary" || key === "coverLetter" ? String(details[key] ?? "").trim() : value
    if (!value) {
      const answer = savedAnswer(label)
      value = clean(answer)
      raw = String(answer ?? "").trim()
    }

    let done = false
    if (value && el.tagName === "SELECT") {
      const option = matchOption(el, value)
      if (option) {
        setValue(el, option.value)
        done = true
      }
    } else if (value && isCombobox(el)) {
      done = await pickOption(el, value)
    } else if (value) {
      const max = el.maxLength > 0 ? el.maxLength : Infinity
      setValue(el, (el.tagName === "TEXTAREA" ? raw : value).slice(0, max))
      done = true
    }
    if (done) mark(el)
    track(el, label, required, done ? "filled" : "empty", done && !(key && values[key]) ? "answer" : key)
  }

  /* ---------------- learning ---------------- */

  // Details your IamCandidate autofill profile has a field for (a full name
  // can't be split reliably, so it isn't learned).
  const DETAIL_KEYS = new Set(RULES.map((rule) => rule.key).filter((key) => key !== "fullName"))
  const PROFILE_FIELD = { location: "city" }

  if (store?.userId && globalThis.chrome?.storage?.local) {
    // The listener stays installed in this frame; later runs only update where it saves.
    globalThis.__iamcandidateStore = store
    if (!globalThis.__iamcandidateLearning) {
      globalThis.__iamcandidateLearning = true
      let queue = Promise.resolve()

      // Queued for IamCandidate, which only fills a detail that's still empty
      // there (what you type on one form may be specific to that job).
      const save = (key, label, value) => {
        const { userId, learnKey } = globalThis.__iamcandidateStore ?? {}
        if (!userId || !learnKey) return
        queue = queue
          .then(async () => {
            const { [learnKey]: stored } = await chrome.storage.local.get(learnKey)
            const own = stored?.userId === userId ? stored : { userId, details: {}, answers: [] }
            if (key) {
              const field = PROFILE_FIELD[key] ?? key
              if (!clean(own.details[field])) own.details[field] = value
            } else {
              const asked = questionKey(label)
              own.answers = own.answers.filter((a) => questionKey(a.question) !== asked)
              own.answers.push({ question: clean(label).slice(0, 500), answer: value })
            }
            await chrome.storage.local.set({ [learnKey]: own })
          })
          .catch(() => {})
      }

      document.addEventListener(
        "change",
        (event) => {
          const el = event.target
          if (!(el instanceof HTMLElement) || !el.matches?.("input, textarea, select")) return
          if (el.type === "radio") {
            if (!el.checked || el.disabled || el.form?.querySelector('input[type="password"]')) return
            const label = groupLabelOf(el)
            const value = optionLabelOf(el)
            if (questionKey(label) && value && !SENSITIVE.test(label.toLowerCase())) save(undefined, label, value)
            return
          }
          if (!usable(el)) return
          const label = labelOf(el)
          if (!questionKey(label) || SENSITIVE.test(describe(el))) return
          const value =
            el.tagName === "SELECT"
              ? el.selectedIndex > 0 || el.value
                ? clean(el.selectedOptions[0]?.textContent)
                : ""
              : el.tagName === "TEXTAREA"
                ? el.value.trim()
                : clean(el.value)
          if (!value || value.length > 20000) return
          const key = keyFor(el)
          if (key && !DETAIL_KEYS.has(key)) return
          save(key, label, value)
        },
        true,
      )
    }
  }

  return { fields, frame: location.hostname }
}

/**
 * Scrolls to a field {@link fillPage} listed and puts the cursor in it.
 * Injected the same way, so it is self-contained too. Resolves to whether
 * the field is still on the page.
 */
export function focusField(id) {
  const el = document.querySelector(`[data-iamcandidate-field="${CSS.escape(id)}"]`)
  if (!el) return false
  // Hidden inputs (file drop zones, styled radios) scroll to what shows them.
  let target = el
  while (target && target !== document.body) {
    const box = target.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) break
    target = target.parentElement
  }
  target = target && target !== document.body ? target : el
  target.scrollIntoView({ block: "center", behavior: "smooth" })
  el.focus?.({ preventScroll: true })
  const previous = target.style.boxShadow
  target.style.transition = "box-shadow 0.3s"
  target.style.boxShadow = "0 0 0 3px oklch(0.75 0.15 70 / 0.7)"
  setTimeout(() => (target.style.boxShadow = previous), 1600)
  return true
}
