# iamcandidate-extension

A Chrome (Manifest V3) extension for [IamCandidate](../iamcandidate-ui). Sign in with your IamCandidate account, then
click the toolbar icon (or press **Alt+K**) while you're applying for a job or looking at
someone's LinkedIn profile.

- **Job application:** reads the posting on the current page (role, company, location,
  work mode, salary, job ID, URL, description) and saves it to IamCandidate as an application.
  Anything it can't find is highlighted ("Not found on page") for you to fill in. It warns
  you if the job is already in IamCandidate.
- **Referral:** on a LinkedIn profile (`linkedin.com/in/…`) it reads the person's name,
  headline, current company and profile URL, then adds them as a contact and creates a
  referral. Pick a saved application to fill in the role and job link. The job you saved
  last is preselected, so the usual order is: save the job, open an employee's profile,
  add the referral.
- **LinkedIn message:** after adding a referral, choose **Message on LinkedIn**, or click
  **Write message** on the Referral tab to message someone without saving anything. It fills one
  of your IamCandidate LinkedIn templates (Templates → LinkedIn) with their first name, company, role and
  job link, shows the count against LinkedIn's 300-character connection-note limit, and copies
  it so you can paste it into LinkedIn. Copying for a saved referral also marks it "Request sent".
- **Autofill side panel:** on the Autofill tab, click **Open autofill panel**. The panel stays
  beside the page and follows the tab you're on. It shows the job (read from the posting, or
  remembered from the posting you opened before its application form), a **resume match** score
  for the resume you pick (which of the skills the job names your resume mentions), and an
  **Autofill this page** button. Autofill attaches your resume's saved file to the form's resume
  upload, types your details (name, email, phone, location, links, current title and company,
  experience, notice period, salary, summary, cover letter) into matching empty fields, picks the
  matching option in searchable dropdowns (location, pronouns…), and reuses your saved answers,
  including forms embedded in an iframe. Then it lists every question it found, required ones
  first, each marked filled, already answered, or needing your answer; click one to jump to it.
  It never overwrites what's already typed, never touches passwords, checkboxes or sign-in forms,
  and never submits. Chrome asks once, on your first Autofill, for access to the sites you apply
  on, so the panel keeps working as you move between pages. Edit your details under **My details**
  in the panel; they're pre-filled from your IamCandidate profile the first time, saved on this
  device, and removed when you sign out. Field matching is in
  [src/lib/autofill.js](src/lib/autofill.js), resume matching in [src/lib/match.js](src/lib/match.js).
- **It learns as you apply:** after you click **Autofill this page**, whatever you type into that
  form is remembered. A detail you hadn't filled in yet (phone, notice period…) is added to your
  details; any other question ("Are you authorized to work in India?", "How did you hear about
  us?", dropdowns, yes/no choices) is saved as an answer and filled in the next time a form asks
  the same question. Saved answers are listed under **Saved answers** in the panel's My details tab, where
  you can forget any of them. Passwords, ID, card and bank numbers, dates of birth and one-time
  codes are never saved.
- Companies and contacts are matched to what's already in IamCandidate, by company name and by
  LinkedIn URL (or exact name). New ones are created only when there's no match.
- Your unsaved input is kept if the popup closes (for example when you click the page to
  copy something), until you save or the browser closes.

No build step and no dependencies: plain ES modules.

## Install (developer mode)

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
   select this `iamcandidate-extension` folder. Edge and Brave work the same way.
2. Pin the extension, click it and sign in with your IamCandidate email and password.

After you change code, click the reload icon on the extension's card.

### Servers

By default the extension talks to the deployed API,
`https://ps4y8f4z9f.execute-api.ap-south-1.amazonaws.com`. In the popup's ⚙ **Settings** you can
change:

- **API URL**: to use a local server, run `cd ../iamcandidate-server && npm run dev` and enter
  `http://localhost:3001`. Chrome asks once for permission to reach localhost.
- **App URL**: where the IamCandidate web app runs, used for "Open in IamCandidate" links. The default is
  `https://knot-ui-eight.vercel.app`; use `http://localhost:3000` with a local `npm run dev`.

Other API hosts must first be added to `host_permissions` in `manifest.json`. The server
doesn't need any CORS changes, because extension pages that have host permission aren't
subject to CORS.

## Publishing to the Chrome Web Store

1. Raise `"version"` in `manifest.json`. Every upload needs a higher version than the last.
2. Build the zip (PowerShell, from this folder):
   ```powershell
   New-Item -ItemType Directory -Force dist; tar.exe -a -c -f dist\iamcandidate-extension-<version>.zip manifest.json icons src
   ```
3. Upload it in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
   The listing text, permission justifications, privacy answers and screenshots are in
   [store/](store/LISTING.md). Host [store/privacy-policy.html](store/privacy-policy.html)
   at a public URL and paste that link into the Privacy tab.

## Supported sites

| Site                                     | How it's read                                               |
| ---------------------------------------- | ----------------------------------------------------------- |
| LinkedIn jobs (`/jobs/view/…`, search/collections with `currentJobId`) | Page selectors, page title, `og:title`     |
| LinkedIn profiles (`/in/…`)              | Top card: name, headline, location, current company         |
| Naukri (`/job-listings-…`)               | Page selectors, plus its JobPosting JSON-LD                 |
| Indeed, Lever, Greenhouse, Ashby, Workday | Page selectors                                             |
| Any other career page                    | schema.org `JobPosting` JSON-LD, `og:` meta tags, `<h1>`    |

Job sites change their markup often. If a field stops being detected, fix the selectors
for that site in [src/lib/extract.js](src/lib/extract.js). You can always type the value
into the popup in the meantime.

## Layout

```
manifest.json        MV3 manifest: popup, Alt+K shortcut, permissions
icons/               toolbar icons (IamCandidate brand mark)
src/popup/           popup UI: sign-in, settings, job + referral forms
src/panel/           autofill side panel: job, resume match, fill report, your details
src/lib/api.js       iamcandidate-server client (Bearer token, envelope unwrapping, 401 → sign-in)
src/lib/extract.js   page reader, injected on demand with chrome.scripting
src/lib/autofill.js  application-form filler, injected on demand with chrome.scripting
src/lib/match.js     resume-to-job keyword match
src/lib/storage.js   settings, session and autofill details (storage.local), drafts (storage.session)
src/lib/constants.js status/work-mode/relationship options (same as the web app)
```

## Permissions

- `activeTab` + `scripting`: read the page when you open the extension on it. The
  extension doesn't run on pages in the background.
- `sidePanel`: the autofill panel.
- `https://*/*`, `http://*/*` (optional): requested on your first **Autofill this page**, so the
  panel can read the job and fill the form on whichever page you're on, and download your resume
  file. Scripts are still only injected when the panel reads a page or you click Autofill.
- `storage`: settings, the session token (kept until you sign out, like the web app),
  your autofill details, the answers learned from forms, and drafts.
- The IamCandidate API host: signing in and saving your data.
- `http://localhost/*`, `http://127.0.0.1/*` (optional): requested only if you point the
  extension at a local iamcandidate-server in Settings.
