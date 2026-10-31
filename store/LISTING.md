# Chrome Web Store listing — copy/paste values

Developer account: ganeshguru8681@gmail.com
Upload: `iamcandidate-extension-1.5.0.zip` (see the README's "Publishing" section)

## Store listing tab

**Name** (from manifest): IamCandidate — Job & Referral Capture

**Summary** (from manifest description, max 132 chars):
Save jobs and LinkedIn referrals to IamCandidate, and autofill application forms with your details and resume.

**Category:** Productivity → Tools
**Language:** English

**Description:**

```
Track your job search without copy-pasting.

While you're applying for a job, click the IamCandidate icon (or press Alt+K). The extension reads the job posting on the page (role, company, location, work mode, salary, job ID, link and description) and saves it to your IamCandidate account as an application. If it can't find something, it highlights the field so you can fill it in.

On a LinkedIn profile, add that person as a referral in one click. Their name, headline, current company and profile link are filled in for you, and you can link the referral to a job you've already saved.

Filling in the application itself? Open the autofill panel beside the page. It shows the job, how well your resume matches its keywords, and an Autofill button that attaches your resume and puts your name, contact details, links, current role, experience, notice period and salary into the matching empty fields, including searchable dropdowns. Then it lists every question on the form, with the required ones still waiting for you called out; click one to jump to it. Turn on Fill forms automatically and application forms are filled as soon as they open, with the toolbar badge counting the required questions left. Nothing is overwritten or submitted: you check the form and submit it yourself. Answers you type into a form are remembered, so the next application that asks the same question is filled in for you.

• Works on popular job boards and most company career pages
• Warns you when a job is already saved
• Matches existing companies and contacts instead of creating duplicates
• Keeps your unsaved input if the popup closes
• Resume match score for each job
• Leaves newsletter, contact and sign-in forms alone

Requires a IamCandidate account.
```

**Icon:** `icons/icon128.png`
**Screenshots (1280×800):** `store/screenshot-job.png`, `store/screenshot-referral.png`

## Privacy tab

**Single purpose:**
Help the user apply for jobs: save job postings and LinkedIn referral contacts from the current page to their IamCandidate account, and fill the application form on the page with their own details.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `activeTab` | Gives access to the current tab only when the user opens the extension, so it can read the job posting or LinkedIn profile they're looking at. |
| `scripting` | Runs the page reader in the current tab (only while the popup or autofill panel is open) to extract job or profile details, and the form filler when the user clicks Autofill this page. |
| `sidePanel` | Shows the autofill panel beside the page: the job, the resume match, and the list of form questions filled or still to answer. |
| `storage` | Stores the user's sign-in session, server settings, the details they enter for autofill, the answers they typed into application forms (to fill the same questions next time), and an unsaved form draft. |
| Host permission `ps4y8f4z9f.execute-api.ap-south-1.amazonaws.com` | The IamCandidate API: signing in and saving applications, companies, contacts and referrals to the user's account. |
| Optional host permissions `https://*/*`, `http://*/*` | Requested only when the user first clicks Autofill this page. Application forms are on any company's site or ATS, and the user moves from the posting to the form, so the panel needs to read the job and fill the form on whichever page they're on, and download the user's own resume file from IamCandidate's storage to attach it. With the user's "Fill forms automatically" switch on, each page they load on those sites is checked for a job application form, which is filled (never submitted); with it off, nothing runs until they click Autofill. |
| Optional host permission `localhost` | Only requested if the user points the extension at a IamCandidate server running on their own computer for development. |

**Remote code:** No, I am not using remote code.

**Data usage — tick:**
- Personally identifiable information (the names and emails of contacts the user saves, and the user's own autofill details)
- Authentication information (IamCandidate email, password and session token)
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
