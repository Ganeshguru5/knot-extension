/**
 * The result of the last fill in each tab (`{ url, fields, auto, at }` in
 * `chrome.storage.session`), so the panel can show it whenever it opens, and
 * the toolbar badge counts the required questions still waiting for you.
 */

export const reportKey = (tabId) => `iamcandidate:report:${tabId}`

export const openRequired = (fields) => fields.filter((f) => f.required && f.status === "empty").length

export async function saveReport(tabId, url, fields, { auto = false } = {}) {
  await chrome.storage.session.set({ [reportKey(tabId)]: { url, fields, auto, at: Date.now() } })
  await setBadge(tabId, fields)
}

/** This tab's report, if it's for the page the tab shows now. */
export async function getReport(tabId, url) {
  const { [reportKey(tabId)]: report } = await chrome.storage.session.get(reportKey(tabId))
  return report && report.url === url ? report : undefined
}

export async function clearReport(tabId) {
  await chrome.storage.session.remove(reportKey(tabId))
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
}

async function setBadge(tabId, fields) {
  const open = openRequired(fields)
  try {
    await chrome.action.setBadgeText({ tabId, text: !fields.length ? "" : open ? String(open) : "✓" })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: open ? "#c27c0e" : "#1f8a7a" })
    await chrome.action.setTitle({
      tabId,
      title: open
        ? `IamCandidate: ${open} required question${open === 1 ? "" : "s"} still need${open === 1 ? "s" : ""} you`
        : "Save to IamCandidate (Alt+K)",
    })
  } catch {
    // The tab closed.
  }
}
