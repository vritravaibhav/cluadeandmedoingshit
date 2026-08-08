# India job sweep — resume instructions

## State
- 2,907 companies scanned across all 26 letter folders (a/ .. z/), each with companies.js + test.js.
- Engine: w/test.js (~30 ATS providers, auto-detect + board-name validation + enrichment).
- Output: weekendplan/{1-java-flutter-2yr,2-java-flutter-3yr,3-software-2yr,4-software-3yr}/jobs.{txt,json}
- Rebuild folders anytime: `node weekendplan/build.js`
- Rescan: `FORCE=1 ./weekendplan/run-letters.sh <letters>`  (scanning costs ~0 tokens; it is pure HTTP)

## Stack-tag defect — FIXED 2026-08-07 (commit 6f30804)
Root cause was NOT what was first recorded. Enrichment fetches a posting's
whole page, which includes the site's services nav ("PHP Development, Java
Development, Flutter App Development"), so agency boards tagged every role
with every stack. Fix: boilerplateStacks() in w/test.js flags keywords that
appear in ALL enriched postings and requires a title match for those.
Only _enriched postings count — non-engineering roles are never opened, so
their clean short text was masking the signal (this is why the first two
attempts silently failed). Verified: Etelligens false tags gone, Wingify true
positives intact (4/20).
A full rescan of all 26 letters was launched after this fix; it self-commits
and pushes when done. Check weekendplan/logs-rescan.log.

## Research status (updated 2026-08-08)
Cycle 2 done: 3,455 companies (was 2,907). 8 agents expanded thin letters, 3
repaired 59 wrong domains. Thin letters now j:91 o:112 q:90 r:152 t:177 u:92
v:157 z:101.
WARNING: those agents added 90 `ats` tokens despite being told not to; they
were stripped before scanning. ALWAYS re-check for invented ats tokens after
any research cycle:
  node -e "for(const L of 'abcdefghijklmnopqrstuvwxyz'.split('')){const c=require('/Users/longfloat/deletelater/jobs/'+L+'/companies.js');const n=c.filter(x=>x.ats).length;if(n)console.log(L,n)}"

Cycle 3 (2026-08-08): built weekendplan/render-scan.js — a Playwright second
pass for boards plain fetch cannot read. Probing 120 flagged boards found no
dominant missing ATS (73% are SPAs that load jobs over XHR), so rendering is
the only general fix. It captures XHR JSON first, falls back to the rendered
DOM, and merges into each letter results.json in place (source="rendered").
Scoring is imported from w/test.js so rendered jobs use identical rules.
GUARDS (learned the hard way — verify any change against them):
  - marketing sites serve blog/case-studies from the same content API, so a
    title+location is NOT enough. Require a role noun (JOBBY) or a requisition
    id, else a telecom vendor contributes 83 case studies.
  - DOM anchors must have a job-ish href; the blog roll and services menu
    ("Hire a Java developer") otherwise sail through.
Run: node weekendplan/render-scan.js [--letters=a,b] [--limit=N]

Next cycle should pick up:
- Letters never expanded by live research: a-i, k-p, s, w, x, y were authored
  from model knowledge only.
- Recheck for invented ats tokens after every research cycle (see above).

## Loop protocol requested by user
1. Work until ~80% of quota consumed.
2. At 80%: stop all agents/workflows, commit + push, then WAIT for reset.
3. On reset (~4h): resume research, push again. Repeat indefinitely.
4. Push to github.com/vritravaibhav/cluadeandmedoingshit every cycle.

## Scheduled loops (session-only — recreate these if Claude was restarted)
- 4h cycle, cron `13 */4 * * *`, recurring: quota-reset cycle. Fix stack-tag defect,
  resume live research, stop at 80% quota, rebuild + push every time.
- 14h chain, one-shot, self-rearming: `git pull`, read `vaibhavclaude.md` at repo root,
  execute the prompt inside it, stop at 80% quota, rebuild + push, then CronCreate the
  next one-shot at +14h with the same prompt. First fire: 2026-08-08 09:18 IST.

## Freelance track (added cycle 4, 2026-08-08)
weekendplan_freelance/build.js reads freelance/results.json (written by
freelance/test.js) and emits a CAPPED, ranked bid list — deliberately unlike
the jobs build. Bids are the scarce resource (Freelancer free tier = 6/month,
Plus = 100), so precision beats recall: 1-bid-now is capped at 60.
  node freelance/test.js && node weekendplan_freelance/build.js
KNOWN DEAD END: generic remote-job boards. An earlier sweep pulled 875 postings
from remoteok/remotive/arbeitnow/jobicy/himalayas/workingnomads/wwr/jobspresso
and got 7 usable, 0 contract. Do NOT add more of those. Only freelancer.com has
had an open gig API. New sources must be probed for an accessible feed first
(see freelance_20260807/probe.js for the pattern) before wiring into
freelance/sources.js.

## User-facing status file
claudevaibhav.md is the report the user reads to track progress from a
distance. Update it EVERY cycle alongside RESUME.md. RESUME.md is engineering
state; claudevaibhav.md is for them — what was asked, what got done, what is
next, what is broken.
