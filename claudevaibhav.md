# Status — from Claude to Vaibhav

You track progress here. I update this file every cycle. Newest first.

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
