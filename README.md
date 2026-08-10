# India job + freelance sweep

Finds software roles in India for a ~2-year engineer (Java/Spring Boot,
Flutter/Dart), and drafts the applications.

## What to open

| | |
|---|---|
| `weekendplan/1-java-flutter-2yr/jobs.txt` | **start here** — Java/Flutter, ~2 years |
| `weekendplan/1-java-flutter-2yr/apply-pack.txt` | those roles with cover notes already written |
| `weekendplan/2-java-flutter-3yr/` | same, roles asking ~3 years |
| `weekendplan/3-software-2yr/` · `4-software-3yr/` | other stacks (Python, Node, .NET, QA, data…) |
| `weekendplan_freelance/1-bid-now/gigs.txt` | freelance shortlist, capped and spread across 9 platforms |
| `weekendplan_freelance/1-bid-now/proposals.txt` | a bid proposal drafted per gig |
| `claudevaibhav.md` | what changed each cycle, newest first |

## Layout

```
engine/       the scanner (test.js), the application-pack generator, paths.js
data/<a-z>/   one directory per company initial: companies.js + results.json
weekendplan/  the four job folders, plus build/QA/render/verify scripts
weekendplan_freelance/   bid list + proposals, and their build
freelance/    the freelance sweep and its per-site adapters
autofill/     browser extension + bridge
```

`engine/paths.js` is the only file that knows where anything lives — change it
there, not in six scripts.

## Running it

```sh
# refresh everything (free: network + CPU only, no model calls)
FORCE=1 ./weekendplan/run-letters.sh            # scan all 26 letters
node weekendplan/render-scan.js                 # second pass in Chromium for JS-only boards
node weekendplan/build.js                       # rebuild the four job folders
node weekendplan_freelance/build.js             # rebuild the bid list
node weekendplan/qa.js                          # MUST pass — see below

# regenerate the written applications
node engine/apply-india.js --from=../weekendplan/1-java-flutter-2yr/jobs.json \
                           --out=../weekendplan/1-java-flutter-2yr/apply-pack.txt --top=60
node weekendplan_freelance/proposals.js --top=20

# occasional maintenance
node weekendplan/verify-domains.js              # are company domains still theirs?
node weekendplan/nulscan.js                     # stray NUL bytes in source
node weekendplan/regexaudit.js                  # /\ba|b|c\b/ precedence bugs
```

## `qa.js` is not optional

Every check in it is a bug that actually shipped into the job folders: blog
posts ranked second in the priority list, an internship at #15, 60 "Hire a
Developer" adverts, a quarter of the freelance bids unworkable from India,
cover letters with an empty evidence list. None of them showed up in any count —
the totals looked healthy throughout. Run it after every build; it exits
non-zero on a regression.

It does not replace reading the files. A *new* failure mode still needs eyes.

## Known limits

- **Aggregators are excluded by design.** Naukri, Instahyre, Cutshort, Hirist,
  Foundit are where most Indian postings live, but crawling them would risk
  attributing one company's jobs to another — and Naukri's `robots.txt`
  disallows us outright. So the counts here are a floor, not a census.
- **About half the company boards yield nothing** — login-gated, bot-walled, or
  genuinely empty. Three rounds of extractor work took recovery from 15% to 31%
  and then to ~3% per pass; further extractor work is not worth it (measured,
  see `RESUME.md`).
- Some rendered boards (Darwinbox especially) publish no per-posting URL, so
  those rows link to the careers page rather than the exact job.
