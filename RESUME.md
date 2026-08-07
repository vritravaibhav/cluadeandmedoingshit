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

## Unfinished research (agents were killed at quota)
Company lists were authored from model knowledge, not live research, so some
domains are wrong -> those show as unreachable in weekendplan/INDEX.txt.
When quota resets, re-run live research per letter to (a) fix dead domains and
(b) add companies, especially thin letters: q(27) j(36) u(38) o(43) z(50) r(60) v(66).

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
