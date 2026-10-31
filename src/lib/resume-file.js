import { api } from "./api.js"

/** Larger files aren't worth passing into the page; you attach those yourself. */
const MAX_RESUME_BYTES = 8 * 1024 * 1024
/** The resume picked in the autofill panel. */
export const RESUME_PREF_KEY = "iamcandidate:panel-resume"

/** The resume you picked in the panel, else your default, else the first. */
export async function preferredResume(resumes) {
  const { [RESUME_PREF_KEY]: preferred } = await chrome.storage.local.get(RESUME_PREF_KEY)
  return resumes.find((r) => r.id === preferred) ?? resumes.find((r) => r.isDefault) ?? resumes[0]
}

/**
 * The resume's saved file as `{ file: { name, type, base64 } }`, or
 * `{ skipped }` with the reason it can't be attached ("" when the resume has
 * no file). Works in the service worker too, so no FileReader.
 */
export async function resumeFile(resume) {
  if (!resume?.documentId) return { skipped: "" }
  try {
    const [doc, link] = await Promise.all([
      api.getDocument(resume.documentId),
      api.getDocumentDownloadUrl(resume.documentId),
    ])
    const response = await fetch(link.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > MAX_RESUME_BYTES) return { skipped: "Your resume file is over 8 MB, so attach it yourself." }
    let binary = ""
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const type = response.headers.get("content-type")?.split(";")[0] || doc.mimeType || "application/pdf"
    let name = doc.name || `${resume.title || "resume"}.pdf`
    if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += type.includes("pdf") ? ".pdf" : ""
    return { file: { name, type, base64: btoa(binary) } }
  } catch (error) {
    console.warn("IamCandidate: could not get the resume file", error)
    return { skipped: "Couldn't download your resume file, so attach it yourself." }
  }
}
