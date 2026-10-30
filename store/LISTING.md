# Chrome Web Store listing — copy/paste values

Developer account: ganeshguru8681@gmail.com
Upload: `iamcandidate-extension-1.2.0.zip` (see the README's "Publishing" section)

## Store listing tab

**Name** (from manifest): iamcandidate — Job & Referral Capture

**Summary** (from manifest description, max 132 chars):
Save the job you're applying to and add referrals from LinkedIn profiles straight into your iamcandidate account.

**Category:** Productivity → Tools
**Language:** English

**Description:**

```
Track your job search without copy-pasting.

While you're applying for a job, click the iamcandidate icon (or press Alt+K). The extension reads the job posting on the page (role, company, location, work mode, salary, job ID, link and description) and saves it to your iamcandidate account as an application. If it can't find something, it highlights the field so you can fill it in.

On a LinkedIn profile, add that person as a referral in one click. Their name, headline, current company and profile link are filled in for you, and you can link the referral to a job you've already saved.

• Works on popular job boards and most company career pages
• Warns you when a job is already saved
• Matches existing companies and contacts instead of creating duplicates
• Keeps your unsaved input if the popup closes
• Reads a page only when you open the extension on it

Requires a iamcandidate account.
```

**Icon:** `icons/icon128.png`
**Screenshots (1280×800):** `store/screenshot-job.png`, `store/screenshot-referral.png`

## Privacy tab

**Single purpose:**
Save job postings and LinkedIn referral contacts from the current page to the user's iamcandidate account.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `activeTab` | Gives access to the current tab only when the user opens the extension, so it can read the job posting or LinkedIn profile they're looking at. |
| `scripting` | Runs the page reader in the current tab (only after the user opens the extension) to extract job or profile details into the form. |
| `storage` | Stores the user's sign-in session, server settings and an unsaved form draft. |
| Host permission `ps4y8f4z9f.execute-api.ap-south-1.amazonaws.com` | The iamcandidate API: signing in and saving applications, companies, contacts and referrals to the user's account. |
| Optional host permission `localhost` | Only requested if the user points the extension at a iamcandidate server running on their own computer for development. |

**Remote code:** No, I am not using remote code.

**Data usage — tick:**
- Personally identifiable information (the names and emails of contacts the user saves)
- Authentication information (iamcandidate email, password and session token)
- Website content (job posting and profile details the user chooses to save)

**Certify all three:**
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** the public URL where you host `store/privacy-policy.html`

## Distribution tab

**Visibility:** Private → Trusted testers
Add trusted testers under **Account → Trusted testers** in the dashboard (e.g. ganeshguru8681@gmail.com).
**Regions:** All regions
