# India job sweep — resume instructions

## State
- 2,907 companies scanned across all 26 letter folders (a/ .. z/), each with companies.js + test.js.
- Engine: w/test.js (~30 ATS providers, auto-detect + board-name validation + enrichment).
- Output: weekendplan/{1-java-flutter-2yr,2-java-flutter-3yr,3-software-2yr,4-software-3yr}/jobs.{txt,json}
- Rebuild folders anytime: `node weekendplan/build.js`
- Rescan: `FORCE=1 ./weekendplan/run-letters.sh <letters>`  (scanning costs ~0 tokens; it is pure HTTP)

## Known defect to fix when quota allows  (TOP PRIORITY)
Stack tags (Java / Flutter) are matched against the WHOLE careers page on
single-page boards, so every role on a `via wordpress:` / `via html:` /
`via headings:` board inherits every keyword. Per-posting ATS boards
(greenhouse/lever/keka/zoho/ashby) are correct.
FIX: in w/test.js `score()`, only set java/flutter from `j.text` when that text
is the posting's OWN text (enriched), not the board page. Then re-run build.js.
Experience windows and India/seniority filters are NOT affected.

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
