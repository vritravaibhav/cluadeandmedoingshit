# Resume Autofill

A Chrome extension that fills in job and freelance application forms from your resume,
plus a small Spring Boot "bridge" that lets it ask Claude Code about the questions your
resume cannot answer.

Written for someone who works in **Java and Flutter**, not JavaScript. Every JavaScript
file in `extension/` is heavily commented for exactly that reason — if something looks
strange, the comment above it explains why it has to be that way.

---

## 1. What this does

You open a Greenhouse / Lever / Ashby / Workday / Freelancer / Upwork application form and
click the extension icon. It:

1. **Scrapes** every input, textarea, select, radio group and checkbox on the page,
   including the ones hidden inside Shadow DOM and inside iframes.
2. **Matches** the obvious ones against your stored profile — "First Name" gets your first
   name, "Email" gets your email. This is pure string matching, no AI, and it works with
   your laptop offline.
3. **Asks Claude** about the leftovers — "Why do you want to work here?", "How many years
   of Spring Boot do you have?", "Do you require visa sponsorship?" — by sending them to a
   local Spring Boot server which shells out to the `claude` CLI you already have installed.
4. **Writes the values in**, outlining each field it touched:
   green = from your profile, blue = from Claude (read these before submitting),
   amber = left for you.

It **never** presses Submit and it **never** touches file-upload fields. Your resume PDF is
still your job.

### Architecture

```
+---------------------------------------------------------------------------+
|  CHROME                                                                   |
|                                                                           |
|  +-------------------+   (1) FILL_ALL   +-----------------------------+   |
|  |  popup.html       |----------------->|  The job application page   |   |
|  |  popup.js         |                  |  greenhouse / lever / ...   |   |
|  |                   |<-----------------|                             |   |
|  |  [ Fill all     ] |   (6) counts     |  content.js  <-- orchestr.  |   |
|  |  [ Fill (no AI) ] |                  |    lib/scrape.js  read form |   |
|  |  [ Undo         ] |                  |    lib/match.js   no-AI map |   |
|  |  [ Scan         ] |                  |    lib/fill.js    write+undo|   |
|  +---------+---------+                  |    lib/profile.js resume    |   |
|            |                            +--------------+--------------+   |
|            | (2) BRIDGE_PING                           | (3) AI_FILL      |
|            v                                           v                  |
|  +---------------------------------------------------------------------+  |
|  |  background.js  --  the MV3 service worker                          |  |
|  |  the ONLY place allowed to make network calls  (see section 11)     |  |
|  +--------------------------------+------------------------------------+  |
+-----------------------------------|---------------------------------------+
                                    | (4) POST http://localhost:3111/fill
                                    |     { "prompt": "..." }
                 +------------------v-----------------------------+
                 |  bridge/  --  Spring Boot 3.3, Java 21          |
                 |    ClaudeBridgeController    POST /fill         |
                 |                              GET  /health       |
                 |    ClaudeCliService          ProcessBuilder     |
                 +------------------+-----------------------------+
                                    | (5) claude -p "<prompt>"
                 +------------------v-----------------------------+
                 |  Claude Code CLI (your existing subscription)   |
                 +------------------------------------------------+
```

Steps (1)–(6) in order: popup asks the page to fill → popup checks the bridge is alive →
page sends its unanswered fields to the service worker → worker POSTs a prompt to Spring →
Spring runs `claude -p` → the answers come back and the page reports its counts.

### Repository layout

```
autofill/
├── README.md                  ← you are here
├── extension/                 ← load THIS folder into Chrome
│   ├── manifest.json
│   ├── background.js          service worker: the only network access
│   ├── content.js             orchestrator, runs inside the job page
│   ├── popup.html / popup.js  the toolbar window
│   ├── options.html / .js     the profile editor
│   └── lib/
│       ├── profile.js         your resume as data + label synonyms
│       ├── scrape.js          form → Field[] 
│       ├── match.js           Field + profile → value (no AI)
│       └── fill.js            writing values React will actually notice
└── bridge/                    ← Spring Boot app, run with mvn
    ├── pom.xml
    └── src/main/java/com/longfloat/autofill/…
```

---

## 2. Prerequisites

| What | Version | Check with |
|---|---|---|
| Google Chrome (or any Chromium: Edge, Brave, Arc) | any current | — |
| JDK | 21 or newer | `java -version` |
| Maven | 3.8+ | `mvn -v` |
| Claude Code CLI, logged in | any | `claude --version` |

There is **no** `mvnw` wrapper in `bridge/`, so Maven has to be installed
(`brew install maven` on macOS).

There is **no** npm, no webpack, no build step for the extension. The JavaScript files are
loaded by Chrome exactly as they are on disk, in the order listed in `manifest.json`. Edit a
file, hit the reload button on `chrome://extensions`, done.

---

## 3. STEP 0 — verify Claude Code headless works  🚦 **GO / NO-GO GATE**

**Do this before anything else.** If this step fails, nothing else in this project can
work, and every later symptom will be a confusing mystery instead of an obvious cause.

### 3.1 Find the binary

```bash
which claude
```

Write the answer down. It will be something like:

```
/opt/homebrew/bin/claude          # Homebrew on Apple Silicon
/usr/local/bin/claude             # Homebrew on Intel, or a manual install
/Users/you/.claude/local/claude   # the official install script
/Users/you/.local/bin/claude      # npm global / pipx style install
```

If `which claude` prints nothing, the CLI is either not installed or it is a shell alias /
function rather than a real file. Check with `type -a claude`. An alias will **not** work
with this project (see §4 for why).

### 3.2 Run one headless prompt

`-p` (short for `--print`) is "non-interactive mode": it reads the prompt, prints the
answer, and exits. That is exactly what the bridge does.

```bash
claude -p "Reply with only this JSON and nothing else: {\"ok\":true}"
```

**Expected:** `{"ok":true}` and an immediate return to your shell prompt.

### 3.3 What "failure" looks like, and what to do

| What you see | What it means | Fix |
|---|---|---|
| A login URL / "Please run `claude` to authenticate" | The CLI has never been logged in, or the token expired | Run plain `claude` (no `-p`), complete the browser login, `/exit`, then retry 3.2 |
| An interactive TUI opens instead of printing | You forgot `-p` | Use `claude -p "..."` |
| It hangs forever with no output | The CLI is waiting on stdin or on a trust prompt | Ctrl-C, run plain `claude` once in the same directory and accept any "do you trust this folder" prompt, then retry |
| `command not found: claude` | Not installed, or not on this shell's PATH | Install the CLI, then re-run `which claude` |
| A macOS **Keychain** dialog appears | The CLI is reading your stored credentials for the first time | Click **Always Allow**. If you click "Allow" once, the dialog reappears on every single call and the bridge will time out |

**Do not proceed until §3.2 prints the JSON and exits.** Everything below assumes it does.

---

## 4. Configure `claude.binary-path` — and why the bare name will not work

Open `bridge/src/main/resources/application.properties` and paste the output of
`which claude`:

```properties
server.port=3111

# ← paste the EXACT output of `which claude` here
claude.binary-path=/opt/homebrew/bin/claude

claude.timeout-seconds=120
```

### Why `claude.binary-path=claude` fails

`ClaudeCliService` starts the CLI like this:

```java
new ProcessBuilder(binaryPath, "-p", prompt).start();
```

`ProcessBuilder` does **not** run your command through a shell. There is no `bash -c`, no
`zsh -ic`, nothing. That means:

* your `~/.zshrc` is never sourced,
* the PATH entries it adds (Homebrew, nvm, `~/.local/bin`, npm's global bin) are never seen,
* the JVM only knows the PATH it inherited from whatever launched it — for a GUI-launched
  IDE on macOS that is a minimal system PATH that usually contains only `/usr/bin` and
  `/bin`.

So `claude` resolves fine when *you* type it, and fails with

```
java.io.IOException: Cannot run program "claude": error=2, No such file or directory
```

when Java tries the same thing. **Always use the absolute path.** This is the single most
common setup failure in this project, which is why `GET /health` echoes the configured path
back to you and the extension's status dot turns red when the file does not exist.

Same reasoning applies to shell aliases and shell functions: `ProcessBuilder` can only start
a real executable file. If `type -a claude` says "claude is an alias for ...", follow the
alias to the real file and use that path.

---

## 5. Run the bridge

```bash
cd autofill/bridge
mvn spring-boot:run
```

You should see the usual Spring banner and:

```
Tomcat started on port 3111 (http)
Started AutofillBridgeApplication in 1.4 seconds
```

Sanity-check it from a second terminal:

```bash
curl http://localhost:3111/health
```

```json
{"status":"UP","claudeBinary":"/opt/homebrew/bin/claude","binaryExists":true}
```

* `"status":"UP"` → good.
* `"status":"DEGRADED"` → Spring is running but `claudeBinary` does not exist on disk.
  Go back to §4.

And the real thing (this takes a few seconds — it is starting the CLI):

```bash
curl -s -X POST http://localhost:3111/fill \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with only this JSON: {\"1\":\"hello\"}"}'
```

```json
{"text":"{\"1\":\"hello\"}","elapsedMs":3921}
```

Leave `mvn spring-boot:run` running in its terminal while you use the extension. Stopping it
does not break anything — the extension simply falls back to profile-only filling.

---

## 6. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`autofill/extension`** folder — the one containing `manifest.json`.
   Not `autofill/`, and not `extension/lib/`.
5. Pin the extension to the toolbar (puzzle-piece icon → pin).

After **any** edit to a file under `extension/`, click the ↻ reload icon on the extension's
card, **then reload the job page**. Chrome does not retro-inject a new content script into
tabs that were already open — that is the cause of the "Reload the page and try again"
message in the popup.

Two consoles are useful and they are different places:

* **The page console** (F12 on the job page) shows `[AF content]` and `[AF]` lines from the
  scraper, matcher and filler.
* **The service worker console** (`chrome://extensions` → this extension → "service worker")
  shows `[AF worker]` lines: the prompt size, the bridge response, and any parse failure
  including the raw text Claude returned.

---

## 7. Edit your profile

Click **Edit profile & settings** at the bottom of the popup (or right-click the extension
icon → Options). You get three boxes:

| Box | Stored as | Notes |
|---|---|---|
| Profile | `profile` (a JSON object) | The whole of `lib/profile.js`, editable. Validated on every keystroke; nothing is saved at all while the JSON is invalid. |
| Bridge URL | `bridgeUrl` (string) | Default `http://localhost:3111`. Only change this if you changed `server.port` — and if you do, also update `host_permissions` in `manifest.json`. |
| Extra instructions | `extraInstructions` (string) | Free text appended to every AI prompt. Good for standing preferences: *"Only apply as a backend engineer, never as a mobile developer"*, *"Always say I can start within 30 days"*, *"Keep answers under 100 words"*. |

Press **Save** (or Ctrl/Cmd+S). New fills pick the changes up immediately; there is no need
to reload anything.

### Fields that are deliberately blank — fill these in first

These were left empty on purpose because the resume does not state them, and inventing data
that goes into real applications is not the extension's decision to make:

| Path | Why it is blank |
|---|---|
| `personal.city`, `personal.state` | The resume gives no home address. The only places it names are an employer office (Dubai) and a university (Panjab University). Application forms ask for your *residence*. |
| `experience[1].location`, `experience[2].location` | The resume states no location for Electromotion E-vidyut or Connect 4 Digital India. |
| `currentCTC`, `expectedCTC` | Salary is a personal decision, not a resume fact. Leave blank to keep the extension from answering salary questions, or fill them in to have it answer automatically. |
| `gender`, `ethnicity`, `veteranStatus`, `disabilityStatus` | US EEO questions. Every one of them accepts "I don't wish to answer", so blank means "leave it to me". Fill them in only if you want them answered automatically. |
| `referredBy` | Per-application by nature. |

Also **check `personal.email`**. It was copied verbatim from the resume as
`divaibhavyanshu@gmail.com`, which reads like it could be a transposition of
`divyanshuvaibhav@…`. A wrong email means an application that silently never reaches you, so
confirm it before the first real submission.

---

## 8. How to test — in this order

Do not start with "Fill all" on a job you actually want. Work up to it.

### 8.1 Scan only (writes nothing)

Open a real posting, for example any job on `https://boards.greenhouse.io/…`, press F12 to
open the console, then click the extension icon → **Scan**.

The popup reports how many fields were found, and the page console prints a table:

```
[AF] scraped 14 field(s) from https://boards.greenhouse.io/acme/jobs/1234
┌─────────┬───────┬──────────────────┬──────────┬───────┬─────────────┐
│ (index) │ kind  │ label            │ required │filled │ options     │
├─────────┼───────┼──────────────────┼──────────┼───────┼─────────────┤
│ 0       │ text  │ 'First Name'     │ true     │ false │ ''          │
│ 1       │ text  │ 'Last Name'      │ true     │ false │ ''          │
│ …
```

**What you are checking:** does the count look right, and do the labels look like the labels
you can see on screen? If it found 0 fields, the form is probably in a cross-origin iframe
that failed to load, or behind a "Apply now" button you have not clicked yet.

#### Driving the scraper by hand from the console

The extension's code runs in an *isolated world*, which is a separate JavaScript scope from
the page's own. So typing `AF` into the console gives `AF is not defined` — until you switch
the console's execution context.

In DevTools → Console, use the context dropdown at the top-left (it says **top** by default)
and pick **Resume Autofill**. Now `AF` exists, and you can:

```js
AF.debugDump()                       // re-print the field table, returns the array
AF.scrapeFields(document).length     // how many fields right now

// why did field #7 get that value — or nothing at all?
AF.explainMatch(AF.scrapeFields(document)[7], AF.DEFAULT_PROFILE)

AF.MIN_CONFIDENCE                    // 0.55; raise it to make matching stricter
```

`explainMatch` returns the top three profile paths it considered, the alias that scored, the
score, and the reason each one was rejected. It is the fastest way to work out whether a
mis-fill needs a new alias or a higher threshold.

### 8.2 Deterministic only (no AI, bridge can be off)

Click **Fill (no AI)**. Name, email, phone, LinkedIn, GitHub and portfolio should turn green.

**What you are checking:** that nothing lands in the wrong box. Pay particular attention to
"Company Name" and "School Name" — they must stay empty, not receive your own name.

Click **Undo**. Everything should return to how it was. If a value comes back after the page
re-renders, see the framework-state row in §9.

### 8.3 Full fill

With `mvn spring-boot:run` running and the popup's dot showing **green / "Bridge online"**,
click **Fill all**.

Profile fields fill instantly; then the popup shows "Filling…" for a few seconds while
`claude -p` thinks; then the remaining fields fill in blue.

**What you are checking:** read every blue field before you submit. That is what blue means.
Watch the service worker console at the same time — it prints the prompt size, how long the
call took, and how many fields Claude chose to answer.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Popup: **"Reload the page and try again."** | The page was open before you installed or reloaded the extension, so no content script is running in it. Chrome never retro-injects. | Reload the job page (Cmd/Ctrl+R). If it persists, check the extension card on `chrome://extensions` for a red "Errors" badge. |
| Popup: **"This is a browser page, not an application form."** | You are on `chrome://…`, the Web Store, or a PDF viewer. Content scripts are banned there by Chrome itself. | Open the real form. |
| Dot is **red / "Bridge offline"** | Nine times out of ten: `mvn spring-boot:run` is not running. | Start it. Then `curl http://localhost:3111/health`. If curl works but the dot stays red, open the service worker console — it prints the exact URL and error. Check `bridgeUrl` on the options page matches the port. |
| Dot is red, but `/health` returns **`"status":"DEGRADED"`** | Spring is up; `claude.binary-path` points at a file that does not exist. | §4. Paste the real output of `which claude`. |
| Popup lists **"AI step skipped: …"** under *Needs you* | The profile fields were filled but the AI stage failed. The message says why. | Deterministic fills are already in the page and are safe to submit; fix the bridge and press **Fill all** again for the rest. |
| **Fields fill visibly, then clear when you click Submit** | Framework state. React/Angular keeps its own copy of every input's value and ignores the DOM. The form submits React's copy, which is still empty. | `lib/fill.js` already defeats this (native value setter + `_valueTracker` reset + a real `InputEvent`). If a specific site still does it, click into the field and type one character then delete it — that forces the framework to resync — and report which site so the event sequence can be extended. |
| **A dropdown stays on "Select…"** | `lib/fill.js` refuses to guess. It matches option text, then value, then a case-insensitive/punctuation-insensitive contains — and if nothing matches it deliberately picks nothing rather than the wrong country. | Pick it by hand. To fix it permanently, add the site's exact option wording as an alias in `lib/profile.js` (e.g. add `"India (IN)"` next to `"India"`). |
| **A custom dropdown (a `<div>` that looks like a select) is untouched** | Not supported yet — see §11. Workday's and Upwork's fancy comboboxes are `<div role="listbox">`, not `<select>`, so there is nothing to set. | Do those by hand. |
| **A macOS Keychain prompt appears on the first `/fill`** | The `claude` CLI is reading its stored credentials from the login keychain, and the JVM is a different process from your terminal, so macOS asks again. | Click **Always Allow**, not "Allow". Then retry. If you keep clicking "Allow", every call re-prompts and the bridge hits its 120s timeout. |
| **Bridge returns 504 CLAUDE_TIMEOUT** | The CLI took longer than `claude.timeout-seconds`, usually because it is blocked on an invisible prompt (login, folder trust, Keychain). | Re-run §3.2 by hand in a terminal. Whatever it asks you there is what the bridge is stuck on. |
| **Bridge returns 502 CLAUDE_FAILED** | The CLI exited non-zero. The response message contains its stderr. | Read the message. Usually "not logged in" or a rate limit. |
| **The popup shows counters that look far too small** | Another frame answered first. With `all_frames: true` every frame gets the message and the first to reply wins; frames with no fields stay silent, but a small frame with two or three fields can still beat the real form. Each frame does still fill its own fields correctly. | Cosmetic. Look at the page, not the numbers. |
| **Nothing at all happens, no error** | A JavaScript error in one of the `lib/` files. | `chrome://extensions` → the extension card → **Errors**. Then the page console. |

---

## 10. ⚠️ Never export `ANTHROPIC_API_KEY`

```bash
# DO NOT DO THIS before starting the bridge
export ANTHROPIC_API_KEY=sk-ant-...
```

If that variable is set in the environment the JVM inherits, the Claude CLI **silently stops
using your subscription login and starts billing that API key instead**. There is no warning,
no prompt, and no visible difference in the output. You find out on the invoice.

This project is designed around the CLI's *subscription* auth, which you already set up in
§3. Keep the key out of:

* your `~/.zshrc` / `~/.bash_profile`,
* the terminal where you run `mvn spring-boot:run`,
* your IDE's run configuration environment variables,
* `application.properties` (nothing here needs it).

Check before starting the bridge:

```bash
echo "$ANTHROPIC_API_KEY"      # must print an empty line
```

If it prints a key, `unset ANTHROPIC_API_KEY` in that terminal before running Maven, and
find out which dotfile is setting it.

---

## 11. What is not built yet

Known and deliberate gaps. None of them break anything; they are just fields you still fill
by hand.

* **Custom JavaScript dropdowns.** Anything that is not a real `<select>` — Workday's
  comboboxes, Ashby's searchable pickers, Upwork's skill tag inputs, React-Select. They
  render as `<div role="combobox">` with a hidden list, so there is no `.value` to set. They
  need a click → wait for the popup list → click the option sequence, with per-site
  selectors. Not implemented.
* **Multi-step / paginated forms.** Workday is five pages long. The extension fills the page
  that is currently visible; it does not click "Next" and continue. Fill a page, click Next
  yourself, click Fill again.
* **File uploads.** Not implemented and not implementable: browsers forbid a script from
  setting `input.files`, for good reasons. The extension counts these fields and lists them
  in the popup under *Needs you (file uploads)* so you know exactly how many to attach.
* **"Add another" repeaters.** Employment-history and education blocks that grow when you
  click a button are filled only for the rows that already exist on screen.
* **Date pickers.** A plain `<input type="date">` works. A JavaScript calendar widget is a
  custom dropdown, so see the first bullet.
* **Per-site tuning.** The matcher is generic. If one ATS keeps mislabelling a field, the fix
  is to add its exact wording to the `aliases` block in `lib/profile.js` — no code change.
* **Profile migrations.** `AF.PROFILE_VERSION` exists and is stored, but nothing reads it
  yet. If the profile shape changes later, a saved profile will need re-saving by hand.
* **Automated tests.** There is no test runner. Verification is the §8 sequence, plus
  `AF.debugDump()` and `AF.explainMatch()` in the page console.

---

## 12. Reminders

* The extension **never** clicks Submit. That is always you.
* Blue outline = Claude wrote it = **read it before you submit it**.
* **Undo** is one-shot per fill and only restores what that fill changed.
* The bridge listens on localhost only and holds no secrets of its own; it is a thin
  `ProcessBuilder` wrapper around a CLI you already have.
* Everything you type into a form is your responsibility, not the extension's. Nothing here
  is allowed to invent an employer, a date, a degree or a number — the prompt says so
  explicitly — but check anyway.
