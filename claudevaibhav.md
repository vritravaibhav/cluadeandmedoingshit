# Status — from Claude to Vaibhav

You track progress here. I update this file every cycle. Newest first.

---

## 2026-08-10 (cycle 19)

This cycle produced a decision rather than a feature, and I think it is the
right one to tell you about plainly.

### I have been chasing the last few percent, and it has stopped paying
I have spent several cycles making the scraper open job boards it previously
could not. Here is what each round actually bought, measured on the boards
still unread when it ran:

**Correction to what I wrote earlier in this entry.** I first quoted per-round
figures of 15%, 31% and 3%. Those were wrong — my own tool was reporting a
running total as if it were that round's result, and the two numbers it printed
disagreed by tenfold. I have fixed the tool so it now says plainly how many
boards were *newly* read versus re-counted.

The honest measurement, taken by counting unread boards before and after:

| | |
|---|---|
| boards the latest round newly opened | **28** |
| boards read in total | 3,080 of 5,949 (**52%**) |
| still unreadable | 2,869 |

A full pass over a thousand boards gaining 28 is the real signal here. The
remaining ones are login-only, bot-blocked, or actually empty.

So I checked two ideas I had queued and dropped both: Oracle-based boards turned
out to be **3 companies**, and browser load failures **0.5%**. Neither is worth
your quota.

I have written this into my notes with the numbers, so a future run does not
quietly restart the same grind.

### I also corrected something I told you earlier
I said Hexaware failed because its job-board link appeared too slowly. That was
wrong. Its careers page **redirects straight to the board** — there was never a
link to wait for. The real problem is that their board is a heavy app that
renders nothing in the time I allow. Same symptom, different cause; the note is
fixed.

### What I will do instead
Your lists and packs are in good shape. The work that actually pays now is
keeping them **fresh** — job postings expire, so re-sweeping matters more than
recovering another thirty boards — and continuing to read the output files by
hand, which has caught a real problem every single time.

### Where things stand

| | |
|---|---|
| Jobs — all four folders | ~3,035 roles (rebuilding as the pass finishes) |
| Application pack | 60 roles |
| Freelance | 60 gigs, 20 proposals |

---

## 2026-08-10 (cycle 18)

Nothing new in `vaibhavclaude.md`, so I went after the thing I admitted was
broken last time.

### Fixed: big employers showing zero jobs
Delhivery, Flipkart and Hexaware were all coming back empty even though I could
find their real job boards. Last cycle I told you I had not solved it.

The cause: reaching the board is not enough. Delhivery's board page renders one
line of text and a link saying **"We Have 8 Open Jobs"** — the jobs are one more
click away. Flipkart's hides everything behind "View All Jobs". My scraper was
arriving, seeing an empty page, and reporting success.

It now follows that link. **Delhivery went from 0 to 5 jobs**, and the letter I
tested on gained 12 companies and 82 postings. A full pass across all 26 letters
is running now.

Honest caveats: Delhivery's system does not publish per-job links, so those
entries point at its careers page rather than the exact posting. And Hexaware
still fails — its link appears too slowly for my scraper to catch. Both written
down rather than glossed over.

### How I found it
Two cycles of reasoning about why it failed got nowhere. Writing a small
throwaway script that walked the same path and printed what it saw at each step
found it on the first run.

### Where things stand

| | |
|---|---|
| Jobs — all four folders | 3,035 roles (rebuilding now) |
| Application pack | 60 roles |
| Freelance | 60 gigs, 20 proposals |

---

## 2026-08-10 (cycle 17)

### I found two bugs of my own that were silently losing your data

**1. Jobs were being filed under the wrong companies.**
My render cache remembered results by *position in the company list* rather than
by company name. That list changes every cycle — research adds companies, domain
checks drop them — so the positions shift. **64 entries had drifted**: Buhler's
job postings were being attributed to Bureau, Engati's to Estuate. Now keyed by
name, which does not move. Buhler and Engati are back on their own listings.

**2. A single invisible character was throwing away an entire pass.**
One of my edits wrote a NUL byte into the code, so the lookup key read
`a<NUL>Company` while the search built `a Company`. Nothing matched. The step
reported "boards recovered: 0" and exited as if it had succeeded — the worst
kind of failure, because it looks like a clean run.

The same data, after the one-character fix: **303 boards, 3,645 postings.**

I have added a checker (`nulscan.js`) and a standing rule against the editing
technique that caused it, so it cannot recur silently.

### Where things stand

| | |
|---|---|
| Jobs — `1-java-flutter-2yr/` | 285 roles, 239 companies |
| Jobs — all four folders | 3,035 roles |
| **Application pack** | **60 roles** (was 25) |
| Freelance — `1-bid-now/` | 60 gigs, 9 platforms |
| Freelance proposals | 20 drafted |

### Something I have not solved
Delhivery, Flipkart and Hexaware still show no jobs. I know exactly where their
real boards are — I can find the URLs — but my scraper opens them and comes back
empty. I have not fixed it and I am not going to claim otherwise; it is the top
item for next time.

### Also closed off
Two boards that fail to load in Chrome (Coforge, MakeMyTrip) turned out to be
7 cases in 1,309 — 0.5%. Not worth more of your quota. Dropped.

---

## 2026-08-09 (cycle 16)

This time I read the **application pack** rather than the job list — the pack is
what actually gets sent, so a mistake there costs you a real impression.

### One of your cover letters was broken
For roles whose posting my scraper could not open (JS-only boards, bot walls),
the letter came out as:

```
Most relevant to this role:
                                    <- nothing here
I'm based in India... and can share code for any of the above.
```

An empty list, then "any of the above" pointing at nothing. Sending that is
**worse than sending no letter** — it reads as careless to the one person you
are trying to impress. Two of the 25 were like this.

Fixed: those now fall back to your three strongest proof points under "What I
bring:". Also stripped junk the applicant systems leak into the location line —
one read `Bangalore, UNAVAILABLE, IN`.

### Something I got wrong and undid
A gig titled "**Flutterwave** App Developer" is sitting in your Flutter
shortlist. Flutterwave is an African payments company, so I assumed my matcher
had tripped on the word "Flutter" inside it and wrote a fix.

The fix did nothing, because that was not the cause — my matcher handles that
correctly, and the gig is tagged "Flutter / Dart" by **Twine itself**. I took my
change back out rather than leave code that claims to fix something it does not.
The gig stays: one borderline listing in sixty is cheaper than a filter that
starts dropping real ones.

### Ready to send

| | |
|---|---|
| `1-java-flutter-2yr/apply-pack.txt` | 25 job applications |
| `2-java-flutter-3yr/apply-pack.txt` | 20 job applications |
| `1-bid-now/proposals.txt` | 20 freelance proposals |

A fresh sweep of all 5,952 companies is running now and will refresh the lists.

### Next
Keep reading the packs, not just the lists. This cycle the list was clean and
the pack was not — I would not have caught it any other way.

---

## 2026-08-09 (cycle 15)

### You can now send, not just browse

| File | What it is |
|---|---|
| `weekendplan/1-java-flutter-2yr/apply-pack.txt` | 25 job applications, written |
| `weekendplan/2-java-flutter-3yr/apply-pack.txt` | 20 more |
| `weekendplan_freelance/1-bid-now/proposals.txt` | **20 freelance bid proposals** |

The freelance proposals are a different thing from the job letters on purpose.
A client is skimming twenty bids and stops reading anything that opens with the
freelancer. So each one opens on what *they* asked for, adds only the evidence
that gig actually earns, and quotes their own words underneath.

**One deliberate gap in them.** Each proposal has a marked blank line for one
sentence about their specific project. I left it blank rather than filling it,
because I do not know their project and a made-up line reads as a template —
and a template bid burns one of your six monthly bids for nothing. Their brief
is quoted right below it, so writing that sentence takes about fifteen seconds
and is the single highest-value edit you can make.

My first version *did* try to fill it, and produced "you're after Flutter, and
the part that usually decides whether it works is getting Flutter right early."
That is filler. I took it out.

### Company list health
Re-checked all 5,952 domains: **5,938 fine**. Fixed three that had moved —
eZee Technosys is now Yanolja Cloud Solution, Webhelp merged into Concentrix,
and Garuda Aerospace was a **typo in my own list** (`garudaerospace` vs
`garudaaerospace`). Dropped three whose domains are gone or parked.

Also fixed a bug in my own checker: it had flagged **Willdan** as a parked
domain because the string `dan.com` appears inside `willdan.com`. A live
company nearly got deleted over a substring match.

### Where things stand

| | |
|---|---|
| Jobs — `1-java-flutter-2yr/` | 286 roles, 238 companies |
| Jobs — all four folders | 3,026 roles |
| Freelance — `1-bid-now/` | 60 gigs, 9 platforms, 0 geo-blocked |
| Ready to send | 45 job applications + 20 proposals |

### Next
- Keep re-reading both lists by hand. Five cycles, still finding things.

---

## 2026-08-09 (cycle 14)

Nothing new in `vaibhavclaude.md`, and both lists read clean, so I went after
what is actually slowing *you* down rather than the scraper.

### You now have an application pack for the whole list
`weekendplan/1-java-flutter-2yr/apply-pack.txt` — **25 roles, ready to send.**

For each one it re-opened the posting, read what the role actually asks for,
and wrote a cover note against it. Not a template with the company name swapped
in — the evidence lines change per role. For the Niramai Android job it pulled
your Flutter apps, Firebase work and NDK/JNI rendering; a Spring Boot backend
role gets the microservices and JPA lines instead. It also lists the answers
every application form asks for (notice period, CTC, work authorisation), so
you are not retyping them 25 times.

23 of the 25 postings were readable; 2 fell back to a generic note and are
labelled as such.

**Why this had never happened:** the generator existed, but it only ever read
one letter's worth of companies — 125 of your 5,952. It could not see the
286-role priority list at all. Now it reads the list directly.

### Where things stand

| | |
|---|---|
| **Jobs** — `1-java-flutter-2yr/` | **286 roles**, 238 companies |
| Jobs — all four folders | 3,026 roles |
| **Freelance** — `1-bid-now/` | 60 gigs, 9 platforms, 0 geo-blocked |
| Application pack | 25 roles written |

### How to use it
Open `apply-pack.txt`, work top down. Each entry has the apply link, what they
asked for, and the note. Regenerate any time, or go deeper than 25:

```
node w/apply-india.js --from=../weekendplan/1-java-flutter-2yr/jobs.json \
                      --out=../weekendplan/1-java-flutter-2yr/apply-pack.txt --top=40
```

These are for sending by hand, deliberately. Auto-submitting gets an address
bot-flagged on Greenhouse and Lever, and that follows you across most of tech
hiring.

### Next
- Extend the pack to folder 2 and the freelance bid list.
- Keep re-reading both lists by hand.

---

## 2026-08-09 (cycle 13)

### A quarter of your bid list was unusable
Reading `1-bid-now/` again, **14 of the 60 gigs could not be worked from India**
— Europe-only or US-only postings. My sweep had already worked that out and
stored it; the file that builds your bid list simply never looked at it.

On six bids a month, that was a quarter of your list spent on work you cannot
take. Now **0 of 60**, and still spread across nine platforms.

One layer wasn't enough: Freelancermap (a German marketplace) marks *all* of
its gigs India-OK, including one titled "Java Developer Remote Across Europe".
So a restriction actually written in the posting now overrides the source's
own optimistic default.

Also dropped a "Python & Flutter **Trainee** Wanted" gig from the top spot —
trainee rates are not what two years of experience should be bidding on.

### Your two lists right now

| | |
|---|---|
| **Jobs** — `1-java-flutter-2yr/` | **286 roles**, 238 companies |
| Jobs total across 4 folders | 3,026 roles |
| **Freelance** — `1-bid-now/` | 60 gigs, 9 platforms, 0 geo-blocked |

The jobs list read clean this time — real junior/SDE-1 roles with sensible
experience windows, no blog posts, no internships, no duplicates.

### Something I should own
This is the third time I have fixed a problem in one place and missed the
identical problem next door — the blog-post filter, the internship filter, and
now the geo check were all fixed on one side and left broken on the other. I
have written that down as a standing check so it stops happening.

### Still the one thing worth doing by hand
Activate the **Freelancer.com Plus free trial** — ₹0, 100 bids instead of 6.

### Next
Keep re-reading both lists. Four cycles running, it is the only check that has
found anything; the totals have looked healthy the whole time.

---

## 2026-08-09 (cycle 12)

Nothing new in `vaibhavclaude.md`, so I audited the **freelance** list by hand —
the one part of your ask I had never actually read. It had two real problems.

### Your bid list was 100% Freelancer.com
All 60 slots in `1-bid-now/` came from freelancer.com. The six new marketplaces
I added for you contributed **646 gigs that never appeared anywhere you'd see
them.**

That is backwards, and it defeats the point of adding them. Bid quotas are **per
platform** — Freelancer's 6-a-month cap says nothing about how many proposals
you can send on PeoplePerHour or Twine. So Freelancer is the *expensive* place
to spend a slot, and it was getting all of them, purely because its listings
carry more text and therefore scored higher.

Now the shortlist round-robins across platforms:

| before | after |
|---|---|
| freelancer.com ×60 | freelancer ×9 · peopleperhour ×9 · twine ×9 · freelancermap ×8 · arc.dev ×8 · hubstaff ×8 · braintrust ×4 · flexiple ×3 · lemon.io ×2 |

**Practical effect:** if the same kind of work is on Twine or PeoplePerHour,
spend the free proposal there and keep your scarce Freelancer bids.

### Off-target gigs were reaching the bid list
"UI/UX designer", "ERP Hosting and Deployment", a blockchain integration — in a
Flutter/Java list. The priority flag I was ranking on turned out to be true for
**all 1,155 gigs**, so it separated nothing. Only 430 actually mention your
stack. Off-target entries in the shortlist: ~30 → **3**.

### Also fixed: internships were scoring as a *bonus*
The scorer treated "intern" as a junior signal and added points, so internships
floated toward the top of a two-year list. They now carry a penalty.

### Jobs — steady

| Folder | Roles | Companies |
|---|---|---|
| `1-java-flutter-2yr/` | **287** | 238 |
| `2-java-flutter-3yr/` | 226 | 174 |
| `3-software-2yr/` | 1,742 | 999 |
| `4-software-3yr/` | 783 | 475 |

### Still the highest-value thing you can do by hand
Activate the **Freelancer.com Plus free trial** — ₹0, 100 bids instead of 6.
With the list now spread across nine platforms, that plus free proposals
elsewhere covers a lot of ground.

### Next
- Re-read both lists by hand again in a few cycles. Three cycles running, that
  is the only check that has found anything; the totals never showed these.

---

## 2026-08-09 (cycle 11)

### Your priority list is now clean

| Folder | Roles | Companies |
|---|---|---|
| `1-java-flutter-2yr/` **(start here)** | **287** | 238 |
| `2-java-flutter-3yr/` | 226 | 174 |
| `3-software-2yr/` | 1,742 | 999 |
| `4-software-3yr/` | 783 | 475 |

**3,038 roles** from 5,952 companies and 67,718 postings swept.

### What I actually found by reading your list instead of counting it
Last cycle I opened `1-java-flutter-2yr/jobs.txt` and read the top of it —
something no total had ever told me. **Four of the top five entries were blog
posts, not jobs**: "How Much Does It Cost to Hire an App Developer?", "Cost to
Hire a Developer in India (2026)". A dev shop's marketing blog comes through
the same RSS feed as its vacancies, and because those articles are *about
hiring*, every filter I had waved them through. Fixed.

This cycle I read it again and found three more, all now fixed:
- A **Stripe internship** sitting at #15. The scorer treats "intern" as a
  junior signal and *adds* points, so internships float to the top of a
  two-year list. Now excluded.
- **Miko's "Junior Java Developer" listed twice** — because one copy said
  "Mumbai" and the other "Mumbai, MH", so my duplicate check missed it.
- Titles carrying board junk: *"Job application for SDE 1 Backend at
  Eshopbox"* now reads *"SDE 1 Backend"*.

I also checked the top 40 apply links: **all 40 live, none broken**.

### Honest note
The blog-post bug was mine twice over — I had already fixed that exact problem
in one part of the pipeline weeks-equivalent earlier, and never checked whether
the other parts had the same hole. They did. Reading your actual file is the
only thing that caught it, so I have made that a standing check every few cycles.

### Freelance — unchanged
60 / 120 / 80 across the three folders. Still the one action worth doing by
hand: activate the **Freelancer.com Plus free trial** (₹0, 100 bids vs 6).

### Next
- Fix the intern scoring at source, not just at output.
- Keep re-reading folder 1 by hand — it keeps finding things.

---

## 2026-08-09 (cycle 8)

Nothing new in `vaibhavclaude.md`, so I took the top item from my own backlog.

### Where the numbers stand

| Folder | Roles | Companies |
|---|---|---|
| `1-java-flutter-2yr/` **(start here)** | **289** | 239 |
| `2-java-flutter-3yr/` | 206 | 163 |
| `3-software-2yr/` | 1,694 | 958 |
| `4-software-3yr/` | 712 | 440 |

**2,901 roles** across 5,952 companies. Folder 1 was 245 two cycles ago.

### A bug that had been silently costing you companies
Verifying every domain turned up 27 "dead" ones — including Fujitsu, DENSO,
Dream11 and Schaeffler. They are obviously not dead. The cause: those companies
publish no DNS record at the bare domain, only at `www.`. My scanner built every
candidate careers URL from the bare domain, so **any company like that was
unreachable no matter what** — it could never be scanned at all. Fixed; Dream11
and Fujitsu now read fine.

Worth saying plainly: my first version of the domain checker would have
**deleted IBM, Fujitsu, DENSO and Dream11** from your lists as dead. I caught it
by testing the checker against the one letter that had already been verified by
hand. Three separate false-positive traps came out of that, all now written down.

### 53 rebranded domains resolved
Companies that were acquired or renamed were producing nothing, because the
scanner checks that your company name appears in the job board's name — an entry
still called "Quizizz" can never match a board that now says "Wayground".
Updated 42 of them (LTIMindtree→LTM, Qualitest→QualityAI, LambdaTest→TestMu AI,
Doubtnut→Allen, Accolite→Bounteous, Apisero→NTT Data, Altair→Siemens…), dropped
4 whose domains now belong to strangers — Logiticks' is an Indonesian lottery
site — and left 7 alone that were only bot-wall artefacts, not real moves.

### Freelance — unchanged
60 / 120 / 80 across the three folders. Still the single best action available:
activate the **Freelancer.com Plus free trial** (₹0, 100 bids vs 6).

### Next
1. 2,888 boards still report no openings. Two render passes recovered 433 of
   them; the rest need a hand-sample to tell a genuine empty board from a third
   extractor gap.
2. Re-verify domains periodically — this sweep found real rot in a list only a
   day old.

---

## 2026-08-08 (cycle 6)

### Where the numbers stand

| | Now | Yesterday |
|---|---|---|
| Companies | **5,827** | 2,907 |
| Postings swept | **67,372** | 54,574 |
| Roles in your 4 folders | **2,495** | 1,849 |

| Folder | Roles | Companies |
|---|---|---|
| `1-java-flutter-2yr/` **(start here)** | **245** | 201 |
| `2-java-flutter-3yr/` | 180 | 140 |
| `3-software-2yr/` | 1,460 | 821 |
| `4-software-3yr/` | 610 | 371 |

### The render pass finally worked
Last cycle it hung for 4h40m and I lost all 163 recovered boards, because I had
it save results only at the very end. Rewritten to save each board the moment
it finishes. This run: **200 boards recovered, 2,652 postings added** — those
are companies that had told the plain scanner they had no openings.

### All 26 letters now researched
Letter `i` was the last one and it died on the quota wall mid-run; it is being
redone now. Every other letter has had live research: **+823 companies** this
cycle (a, c, e, m, s).

### Freelance — unchanged since yesterday
`weekendplan_freelance/` still has 60 / 120 / 80 items across the three folders,
from 2,870 postings and 9 gig marketplaces. Reminder of the one action worth
doing by hand: activate the **Freelancer.com Plus free trial** (₹0, 100 bids vs
6). Everything else is downstream of that.

### Honest note on quota
I hit the session limit at 10:41 this morning, mid-research. The loop did what
it is designed to do — stopped, kept the finished work, and waited for the
1:40pm reset rather than failing halfway through a write. Five of six letters
had already landed, so nothing was lost.

### Next
1. Rescan with the 823 new companies (running now, free — no quota).
2. Re-sample boards still reporting "no openings" after the render pass; 1,021
   of 1,221 did not recover and I have not yet checked whether they are genuinely
   empty or a second extractor gap.
3. Freelance: the adapters are new — check their yield holds up over a few days
   before trusting the rankings.

---

## 2026-08-08 (cycle 4)

### What you asked for in `vaibhavclaude.md`
> do for freelance what you did for jobs, inside weekendplan_freelance · make it
> more concise because freelance sites limit applications · grab from more
> websites · keep pushing · add a 24hr watch · report in claudevaibhav.md

**Done:** freelance folders, the concise shaping, the 24h watch, this file.
**Done too:** 6 new freelance sources wired in — details below.

### Freelance — `weekendplan_freelance/`   [UPDATED: 6 new sources wired in]

Built it deliberately **unlike** the jobs sweep. Jobs maximise coverage because
applying is free. Freelance is the opposite problem: Freelancer's free tier is
**6 bids/month**, Plus is 100. A list of 1,380 gigs is useless when you can act
on a few dozen — so folder 1 is **capped and ranked**, not exhaustive.

| Folder | Items | What it is |
|---|---|---|
| `1-bid-now/` | 60 | Biddable gigs, Flutter/Java, best fit. Capped on purpose. |
| `2-worth-a-look/` | 120 | Real gigs, weaker or unscored fit. Open when folder 1 is spent. |
| `3-contract-roles/` | 80 | Longer contract engagements — applications, **no bid cap**. |

**Sources tripled.** I probed 26 freelance platforms and wired in 6 that have
a real, permitted feed: Flexiple, Freelancermap, Hubstaff Talent, lemon.io,
PeoplePerHour, Twine. Gig marketplaces went 3 -> 9 and the sweep went
**1,380 -> 2,870 postings, biddable gigs 505 -> 1,155**.

The rest were rejected for concrete reasons, now recorded so no future cycle
wastes time on them: Worknhire and Outsourcely are dead domains; Toptal,
Wellfound, Guru and Truelancer sit behind anti-bot walls; Internshala and
Turing disallow bots in robots.txt; Contra, Gun.io and Codementor have no
public gig feed at all. I did not bypass any block or build a login scraper —
where a site says no, the answer is no.

One trap worth knowing: Rozgar's `/api/jobs` returns HTTP 200 — but the body
is just its 750KB app shell. Trusting the status code would have fed junk into
your list. Endpoints get judged on payload here, never on status.

Read `weekendplan_freelance/1-bid-now/gigs.txt` top-down and stop when you run
out of bids. Rebuild anytime: `node weekendplan_freelance/build.js`.

**The single highest-value thing you can do**, from the earlier research in
`freelance/PLATFORMS.md`: activate the **Freelancer.com Plus free trial** —
₹0 for one month, 100 bids instead of 6. That alone unblocks the whole queue.
Set a reminder to downgrade before it renews at ₹799.

### Jobs — `weekendplan/`

| | |
|---|---|
| Companies | **5,008** (was 2,907 yesterday) |
| Postings swept | 54,574 → re-sweeping now with the new companies |
| Roles in your 4 folders | 1,849 at last build |

Two fixes landed that made folder 1 trustworthy:
- **False Java/Flutter tags.** Agency careers pages carry a services nav
  ("PHP Development · Java Development · Flutter App Development") that got
  pulled into every posting, so React Native roles read as Java. 15 false roles
  removed from folder 1.
- **Boards that lied about being empty.** 1,250 companies reported "no
  openings" — including Flipkart, Coforge, Delhivery, Nykaa, Hexaware. They are
  single-page apps that load jobs over XHR, so there was nothing in the HTML to
  read. Added a Chromium render pass.

### Honest problems this cycle

- **A render run hung for 4h40m** on the last 4 of 1,064 boards and had to be
  killed. Because I had it merge results only at the very end, **163 recovered
  boards were lost**. Fixed both causes: hard per-board deadline, and results
  now written incrementally so a kill costs only the board in flight. The run is
  redoing that work now.
- Research agents invented **90 fake ATS tokens** in an earlier cycle — those
  silently scrape a *different* company's jobs. Stripped before any scan, and
  after I spelled out the failure mode in the prompt the next 12 agents produced
  **zero**. There is now a standing check for it.

### Running unattended right now
- Full re-sweep of all 5,008 companies, then the render pass, then rebuild —
  self-pushes when done.
- Freelance sweep refresh, then rebuild.

### Next
1. Live research for letters a, c, e, i, m, s — the last 6 never researched.
2. Sample the boards still reporting "no openings" after the render pass.

### Watches running
| Every | Does |
|---|---|
| 4h | Job sweep cycle — fix, research, rebuild, push |
| 14h | Pull, read `vaibhavclaude.md`, execute it, push, re-arm |
| 24h | Same as 14h plus a full status write-up here |

⚠️ These schedules live in the Claude session's memory, not on disk. If Claude
is closed they stop. `RESUME.md` records their exact schedules so they can be
re-armed — open Claude in this folder and say "re-arm the loops in RESUME.md".

Keep putting new tasks in `vaibhavclaude.md`. I read it every cycle.
