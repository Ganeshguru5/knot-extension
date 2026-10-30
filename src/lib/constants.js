/** Option lists — same values and labels as `iamcandidate-ui/src/lib/constants.ts`. */

export const APPLICATION_STATUSES = [
  { value: "wishlist", label: "Wishlist" },
  { value: "applied", label: "Applied" },
  { value: "recruiter", label: "Recruiter" },
  { value: "technical", label: "Technical Interview" },
  { value: "hr", label: "HR" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "Rejected" },
]

export const WORK_MODES = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On-site" },
]

export const PRIORITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

export const RELATIONSHIPS = [
  { value: "employee", label: "Employee" },
  { value: "referral", label: "Referral" },
  { value: "recruiter", label: "Recruiter" },
  { value: "hiring_manager", label: "Hiring Manager" },
  { value: "friend", label: "Friend" },
  { value: "professional", label: "Professional Connection" },
]

export const REFERRAL_STATUSES = [
  { value: "not_contacted", label: "Not contacted" },
  { value: "request_sent", label: "Request sent" },
  { value: "accepted", label: "Accepted" },
  { value: "submitted", label: "Referral submitted" },
  { value: "declined", label: "Declined" },
  { value: "no_response", label: "No response" },
]

/** Server-side length limits (`iamcandidate-server/src/schemas`). */
export const LIMITS = {
  short: 200,
  phone: 50,
  url: 2048,
  long: 20000,
}
