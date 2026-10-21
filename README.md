# knot-extension

A Chrome (Manifest V3) extension for [knot](../knot). Sign in with your knot account, then
click the toolbar icon (or press **Alt+K**) while you're applying for a job or looking at
someone's LinkedIn profile.

- **Job application:** reads the posting on the current page (role, company, location,
  work mode, salary, job ID, URL, description) and saves it to knot as an application.
  Anything it can't find is highlighted ("Not found on page") for you to fill in. It warns
  you if the job is already in knot.
- **Referral:** on a LinkedIn profile (`linkedin.com/in/…`) it reads the person's name,
  headline, current company and profile URL, then adds them as a contact and creates a
  referral. Pick a saved application to fill in the role and job link. The job you saved
  last is preselected, so the usual order is: save the job, open an employee's profile,
  add the referral.
- Companies and contacts are matched to what's already in knot, by company name and by
  LinkedIn URL (or exact name). New ones are created only when there's no match.
- Your unsaved input is kept if the popup closes (for example when you click the page to
  copy something), until you save or the browser closes.

No build step and no dependencies: plain ES modules.

## Install (developer mode)

1. Start the backend: `cd ../knot-server && npm run dev` (API on `http://localhost:3001`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
   select this `knot-extension` folder. Edge and Brave work the same way.
3. Pin the extension, click it and sign in with your knot email and password.

After you change code, click the reload icon on the extension's card.

### Using a deployed API

Open the popup's ⚙ **Settings** and set:

- **API URL**: the `ApiUrl` output of `sam deploy`
- **App URL**: where the knot web app is hosted (used for "Open in knot" links)

Chrome asks you once to let the extension reach that host. The server doesn't need any CORS
changes. Extension pages that have host permission aren't subject to CORS.

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
icons/               toolbar icons (knot brand mark)
src/popup/           popup UI: sign-in, settings, job + referral forms
src/lib/api.js       knot-server client (Bearer token, envelope unwrapping, 401 → sign-in)
src/lib/extract.js   page reader, injected on demand with chrome.scripting
src/lib/storage.js   settings and session (storage.local), drafts (storage.session)
src/lib/constants.js status/work-mode/relationship options (same as the web app)
```

## Permissions

- `activeTab` + `scripting`: read the page only when you open the extension on it. The
  extension doesn't run on pages in the background.
- `storage`: settings, the session token (expires after 12 hours, like the web app) and
  drafts.
- `http://localhost/*`, `http://127.0.0.1/*`: the local API. Other API hosts are requested
  at runtime when you set them in Settings.
