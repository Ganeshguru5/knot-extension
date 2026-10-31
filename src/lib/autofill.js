/**
 * Fills a job application form on the current page from your autofill details.
 *
 * Injected with `chrome.scripting.executeScript({ func: fillPage, args: [details] })`,
 * so it is serialized and runs inside the page: it must stay fully
 * self-contained (no imports, no references to anything outside this function).
 *
 * It only types into fields. It never clicks a button, presses Enter, or calls
 * `form.submit()` / `requestSubmit()`: you review the form and submit it
 * yourself. Fields that already have a value are left alone, and so are
 * passwords, file uploads, checkboxes, radios and sign-in forms.
 *
 * Returns `{ filled: [{ key, label }], frame }` for this frame.
 */
export function fillPage(details) {
  const clean = (value) =>
    String(value ?? "")
      .replace(/ /g, " ")
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

  const textOf = (el) => clean(el?.innerText ?? el?.textContent)

  /** The visible question for a field: its <label>, aria labels, or the text just before it. */
  const labelOf = (el) => {
    const parts = []
    if (el.labels?.length) parts.push(...[...el.labels].map(textOf))
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

  /* ---------------- writing ---------------- */

  const SKIP_TYPES = new Set([
    "hidden", "password", "file", "checkbox", "radio", "submit", "button",
    "reset", "image", "search", "range", "color", "date", "datetime-local", "month", "week", "time",
  ])

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
    if (el.disabled || el.readOnly) continue
    if (el.tagName === "INPUT" && SKIP_TYPES.has((el.type || "text").toLowerCase())) continue
    // Sign-in and sign-up forms aren't applications.
    if (el.form?.querySelector('input[type="password"]')) continue
    if (!visible(el)) continue

    const key = keyFor(el)
    const value = clean(key ? values[key] : "")
    if (!key || !value) continue

    if (el.tagName === "SELECT") {
      if (el.value && el.selectedIndex > 0) continue
      const option = matchOption(el, value)
      if (!option) continue
      setValue(el, option.value)
    } else {
      if (el.value.trim()) continue
      const max = el.maxLength > 0 ? el.maxLength : Infinity
      const text = key === "summary" || key === "coverLetter" ? String(details[key]).trim() : value
      setValue(el, text.slice(0, max))
    }
    mark(el)
    filled.push({ key, label: clean(labelOf(el)).slice(0, 80) || key })
  }

  return { filled, frame: location.hostname }
}
