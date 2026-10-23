import { clearSession, getSession, getSettings, saveSession } from "./storage.js"

/**
 * Client for the knot-server API. Responses use the envelope
 * `{ success, data }` / `{ success: false, error }`; this unwraps it and
 * throws {@link ApiError} with a readable message.
 *
 * Requests run from the extension's own pages, so CORS doesn't apply as long
 * as the API origin is in the granted host permissions (see `ensureApiAccess`).
 */
export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

/** "Invalid request body" alone isn't actionable; name the fields that failed. */
function describeError(error) {
  if (!error) return undefined
  if (error.code !== "VALIDATION_ERROR" || !Array.isArray(error.details)) return error.message
  const fields = error.details
    .slice(0, 3)
    .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
    .filter(Boolean)
  return fields.length ? `${error.message} — ${fields.join("; ")}` : error.message
}

/** Host-permission match pattern for a URL (patterns can't carry a port). */
export function originPattern(url) {
  const { protocol, hostname } = new URL(url)
  return `${protocol}//${hostname}/*`
}

/**
 * Asks for access to the API host (resolves true at once, without a prompt,
 * when it's already granted — e.g. localhost). Call it synchronously from a
 * click/submit handler, before any `await`: Chrome requires a user gesture.
 */
export function ensureApiAccess(apiUrl) {
  return chrome.permissions.request({ origins: [originPattern(apiUrl)] })
}

async function send(method, path, body, { token, apiUrl } = {}) {
  const settings = apiUrl ? { apiUrl } : await getSettings()
  const session = token ? { token } : await getSession()

  const headers = {}
  if (body !== undefined) headers["content-type"] = "application/json"
  if (session?.token) headers.authorization = `Bearer ${session.token}`

  let response
  try {
    response = await fetch(`${settings.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(
      `Can't reach knot at ${settings.apiUrl}. Is the server running, and is the URL right in Settings?`,
      0,
      "NETWORK_ERROR",
    )
  }

  if (response.status === 204) return undefined

  let envelope
  try {
    envelope = await response.json()
  } catch {
    // Non-JSON response (e.g. a gateway error page).
  }
  // Expired or revoked session: forget it so the popup shows the sign-in form.
  if (response.status === 401 && session?.token) await clearSession()
  if (!response.ok || !envelope?.success) {
    throw new ApiError(
      describeError(envelope?.error) ?? `Request failed (${response.status})`,
      response.status,
      envelope?.error?.code ?? "HTTP_ERROR",
      envelope?.error?.details,
    )
  }
  return envelope.data
}

const enc = encodeURIComponent

/** Refresh at most daily; tokens last a year, so regular use never signs you out. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

function toSession(data, apiUrl) {
  return {
    token: data.token,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (data.expiresIn ?? 43200) * 1000,
    user: data.user,
    apiUrl,
  }
}

export const api = {
  /** Signs in and stores the session. */
  async login(apiUrl, email, password) {
    const session = toSession(await send("POST", "/auth/login", { email, password }, { apiUrl }), apiUrl)
    await saveSession(session)
    return session
  },

  /**
   * Rolling sessions: swaps a token older than a day for a fresh one, so you
   * stay signed in until you sign out. Returns the current session. Network
   * errors keep the old token; a 401 signs out (handled in `send`).
   */
  async refreshIfStale(session) {
    if (Date.now() - (session.issuedAt ?? 0) < REFRESH_AFTER_MS) return session
    try {
      const next = toSession(await send("POST", "/auth/refresh"), session.apiUrl)
      await saveSession(next)
      return next
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error
      return session
    }
  },
  me: () => send("GET", "/auth/me"),

  listCompanies: () => send("GET", "/companies"),
  createCompany: (input) => send("POST", "/companies", input),

  listContacts: () => send("GET", "/contacts"),
  createContact: (input) => send("POST", "/contacts", input),
  updateContact: (id, patch) => send("PUT", `/contacts/${enc(id)}`, patch),

  listApplications: () => send("GET", "/applications"),
  createApplication: (input) => send("POST", "/applications", input),

  listResumes: () => send("GET", "/resumes"),

  listReferrals: () => send("GET", "/referrals"),
  createReferral: (input) => send("POST", "/referrals", input),
  updateReferral: (id, patch) => send("PUT", `/referrals/${enc(id)}`, patch),

  /** Email and LinkedIn templates (the server seeds the defaults on first read). */
  listTemplates: () => send("GET", "/templates"),
}
