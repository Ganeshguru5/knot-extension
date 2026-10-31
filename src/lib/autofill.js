/**
 * Fills a job application form on the current page from your autofill details
 * and the answers you gave on earlier forms, then learns from what you type.
 *
 * Injected with
 * `chrome.scripting.executeScript({ func: fillPage, args: [details, answers, store] })`,
 * so it is serialized and runs inside the page (as a content script): it must
 * stay fully self-contained (no imports, no references to anything outside
 * this function). `store` is `{ userId, detailsKey, answersKey }`: where in
 * `chrome.storage.local` to save what it learns.
 *
 * It only types into fields and picks radio options. It never clicks a button,
 * presses Enter, or calls `form.submit()` / `requestSubmit()`: you review the
 * form and submit it yourself. Fields that already have a value are left
 * alone, and so are passwords, file uploads, checkboxes and sign-in forms.
 *
 * Learning: once it has run in a frame, every question you answer there is
 * saved. A field that is one of your details (phone, notice period…) fills
 * that detail if it was empty; any other question is saved as an answer,
 * keyed by its label, and filled on the next form that asks the same thing.
 * Sensitive fields (IDs, card numbers, codes) are never saved.
 *
 * Returns `{ filled: [{ key, label }], frame }` for this frame.
 */
export function fillPage(details, answers = {}, store = undefined) {
  const clean = (value) =>
    String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim()

  /* ---------------- what each field is ---------------- */

  // Most specific first: the first rule that matches a field wins.
  // `ac` is the HTML autocomplete token; `not` rules out look-alikes.
  const RULES = [
    { key: "linkedin", re: /linked\s?in/ },
    { key: "github", re: /git\s?hub/ },
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
    /password|passcode|\bpin\b|\bssn\b|social security|card (number|no)|credit card|debit card|\bcvv\b|\bcvc\b|expiry|iban|swift|routing|account (number|no)|aadhaa?r|\bpan\b|passport|national id|date of birth|\bdob\b|birth ?date|\botp\b|one.time|verification code|captcha|security (question|answer)/

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

  /* ---------------- values ---------------- */

  const name = clean(details.fullName)
  const [first = "", ...rest] = name.split(" ")
  const values = {
    ...details,
    fullName: name || clean(`${details.firstName ?? ""} ${details.lastName ?? ""}`),
    firstName: clean(details.firstName) || first,
    lastName: clean(details.lastName) || rest.join(" "),
  }
  const savedAnswer = (label) => answers?.[questionKey(label)]?.value

  /* ---------------- writing ---------------- */

  const SKIP_TYPES = new Set([
    "hidden", "password", "file", "checkbox", "radio", "submit", "button",
    "reset", "image", "search", "range", "color", "date", "datetime-local", "month", "week", "time",
  ])

  /** Fields we fill and learn from (radios are handled as groups). */
  const usable = (el) => {
    if (el.disabled || el.readOnly) return false
    if (el.tagName === "INPUT" && SKIP_TYPES.has((el.type || "text").toLowerCase())) return false
    // Sign-in and sign-up forms aren't applications.
    return !el.form?.querySelector('input[type="password"]')
  }

  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden") return false
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }

  /** React, Vue and Angular track the value through the prototype setter, so
   * set it there and announce it with the events they listen to. No key events:
   * an Enter could submit the form. */
  const setValue = (el, value) => {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    el.dispatchEvent(new FocusEvent("blur"))
  }

  /** The option whose text or value matches, e.g. "India" in a country list. */
  const matchOption = (select, value) => {
    const want = clean(value).toLowerCase()
    if (!want) return undefined
    const options = [...select.options].filter((o) => !o.disabled && o.value !== "")
    return (
      options.find((o) => clean(o.textContent).toLowerCase() === want || o.value.toLowerCase() === want) ??
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

  const filled = []
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (!usable(el) || !visible(el)) continue

    const key = keyFor(el)
    const label = labelOf(el)
    let value = clean(key ? values[key] : "")
    let raw = key === "summary" || key === "coverLetter" ? String(details[key] ?? "").trim() : value
    if (!value) {
      const answer = savedAnswer(label)
      value = clean(answer)
      raw = String(answer ?? "").trim()
    }
    if (!value) continue

    if (el.tagName === "SELECT") {
      if (el.value && el.selectedIndex > 0) continue
      const option = matchOption(el, value)
      if (!option) continue
      setValue(el, option.value)
    } else {
      if (el.value.trim()) continue
      const max = el.maxLength > 0 ? el.maxLength : Infinity
      setValue(el, (el.tagName === "TEXTAREA" ? raw : value).slice(0, max))
    }
    mark(el)
    filled.push({ key: key && values[key] ? key : "answer", label: clean(label).slice(0, 80) || key })
  }

  // Yes/no and multiple-choice questions you answered before.
  const groups = new Set()
  for (const radio of document.querySelectorAll('input[type="radio"]')) {
    const group = groupOf(radio)
    if (!group || groups.has(group)) continue
    groups.add(group)
    const options = [...group.querySelectorAll('input[type="radio"]')].filter((r) => !r.disabled && visible(r))
    if (!options.length || options.some((r) => r.checked)) continue
    const label = groupLabelOf(radio)
    const want = clean(savedAnswer(label)).toLowerCase()
    const choice = want && options.find((r) => optionLabelOf(r).toLowerCase() === want)
    if (!choice) continue
    // A radio can't submit a form; clicking it is how frameworks expect it to change.
    choice.click()
    mark(choice.labels?.[0] ?? choice)
    filled.push({ key: "answer", label: label.slice(0, 80) })
  }

  /* ---------------- learning ---------------- */

  // Details the popup has a field for (first/last name are derived from the full name).
  const DETAIL_KEYS = new Set(RULES.map((rule) => rule.key).filter((key) => key !== "firstName" && key !== "lastName"))

  if (store?.userId && globalThis.chrome?.storage?.local) {
    // The listener stays installed in this frame; later runs only update where it saves.
    globalThis.__iamcandidateStore = store
    if (!globalThis.__iamcandidateLearning) {
      globalThis.__iamcandidateLearning = true
      let queue = Promise.resolve()

      const save = (key, label, value) => {
        const { userId, detailsKey, answersKey } = globalThis.__iamcandidateStore ?? {}
        if (!userId) return
        queue = queue
          .then(async () => {
            const stored = await chrome.storage.local.get([detailsKey, answersKey])
            const ownDetails = stored[detailsKey]?.userId === userId ? stored[detailsKey].details : {}
            if (key) {
              // Only fill in a missing detail: what you type on one form may be specific to that job.
              if (clean(ownDetails?.[key])) return
              await chrome.storage.local.set({
                [detailsKey]: { userId, details: { ...ownDetails, [key]: value } },
              })
              return
            }
            const own = stored[answersKey]?.userId === userId ? stored[answersKey].answers : {}
            await chrome.storage.local.set({
              [answersKey]: {
                userId,
                answers: { ...own, [questionKey(label)]: { label: clean(label).slice(0, 200), value, savedAt: Date.now() } },
              },
            })
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

  return { filled, frame: location.hostname }
}
