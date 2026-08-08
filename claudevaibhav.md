# Status — from Claude to Vaibhav

You track progress here. I update this file every cycle. Newest first.

---

## 2026-08-08 (cycle 4)

### What you asked for in `vaibhavclaude.md`
> do for freelance what you did for jobs, inside weekendplan_freelance · make it
> more concise because freelance sites limit applications · grab from more
> websites · keep pushing · add a 24hr watch · report in claudevaibhav.md

**Done:** freelance folders, the concise shaping, the 24h watch, this file.
**In progress:** more freelance sources (see "Next" below).

### Freelance — `weekendplan_freelance/`

Built it deliberately **unlike** the jobs sweep. Jobs maximise coverage because
applying is free. Freelance is the opposite problem: Freelancer's free tier is
**6 bids/month**, Plus is 100. A list of 1,380 gigs is useless when you can act
on a few dozen — so folder 1 is **capped and ranked**, not exhaustive.

| Folder | Items | What it is |
|---|---|---|
| `1-bid-now/` | 60 | Biddable gigs, Flutter/Java, best fit. Capped on purpose. |
| `2-worth-a-look/` | 120 | Real gigs, weaker or unscored fit. Only open when folder 1 is spent. |
| `3-contract-roles/` | 62 | Longer contract engagements from job boards — applications, **no bid cap**. |

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
1. **More freelance sources.** Note the constraint: generic remote-job boards
   are a dead end here — an earlier sweep pulled 875 postings from them and got
   7 usable, 0 actual contract gigs. So the work is real gig marketplaces
   (Truelancer, PeoplePerHour, Guru, Contra, Wellfound contract, Toptal-style
   networks), and most need probing for an accessible feed before they are
   worth wiring in. Only Freelancer.com has had an open API so far.
2. Live research for letters a, c, e, i, m, s — the last 6 never researched.
3. Sample the boards still reporting "no openings" after the render pass.

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
