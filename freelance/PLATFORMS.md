# Freelance platform sweep — recommendation

Written 2026-08-07. Candidate: India-based, ~2 yrs professional, Spring Boot + Flutter +
Android NDK/WebRTC. Constraint that triggered this: Freelancer.com free tier exhausted,
450 queued gigs he cannot bid on.

Every number below is either quoted from a primary source or marked **unconfirmed**.
Fee and geo claims I could not verify are labelled as gaps, not guessed.

---

## 1. Start here this week

Ranked by expected value per hour, given he has a full-time job and maybe 10 spare hours.

### 1. Activate the Freelancer.com **Plus free trial** — ₹0, 100 bids, tonight (30 min)

This is the entire problem solved for zero rupees and it was missed in the original sweep.
Verified live on `freelancer.in/membership` today:

| Tier | INR/mo | Bids/mo |
|---|---|---|
| Free | ₹0 | 6 (grows with account standing) |
| Basic | ₹399 | 50 |
| **Plus** | **₹799 — 1 month FREE trial** | **100** |
| Professional | ₹2,999 | 300 |
| Premier | ₹5,999 | 1,500 |

100 bids at zero cost covers every gig in his queue worth bidding on, twice over. He does
not need to migrate anywhere to unblock 450 gigs — he needs to click "Start Free Trial".

**Freshness check I ran:** 118 of the 166 Flutter/Spring items in `apply-queue.json` are
*still* in Freelancer's live active-projects feed two days after the sweep. The queue has
not rotted. Bid it now. Full math in §4.

**First action:** start the Plus trial, then run `apply.js` in review mode filtered to
`usd >= 400 && fit >= 120` — that is 52 gigs, median value $663. Set a calendar reminder to
cancel or downgrade to Basic (₹399) before the trial renews at ₹799.

### 2. Wire the four verified feeds into `sources.js` (2 hours)

I re-probed these today with plain curl. All four return structured JSON, no auth, no
Playwright. This is the permanent fix to discovery and it plugs straight into his existing
adapter shape. Endpoints and record shapes in §3.

- **Braintrust** `app.usebraintrust.com/api/jobs/` — 126 live jobs, per-posting country list
- **Arc.dev** `arc.dev/remote-jobs/<skill>` → `__NEXT_DATA__` — has a machine-readable
  `requiredCountries` field, the only India-eligibility flag in this entire sweep
- **Torre** `search.torre.co/opportunities/_search/` — 301 hits on "flutter" alone
- **Jobgether** `jobgether.com/astroapi/ai/jobs?keyword=` — explicitly allowed in robots.txt

Cost: one evening. It runs forever afterwards.

### 3. Apply to **Braintrust** — but rewrite the profile first (2 hours, one shot only)

Zero fee, zero bid quota, no application cap, India accepted (17 of 126 live postings list
India), 15% fee charged to the *client* not him. Decision in 3 business days. This is the
platform most likely to say yes to a 2-year engineer this month.

**The trap:** rejection locks him out for **6 months**. And the board today has
**0 Flutter, 0 Spring Boot, 0 Android, 0 Kotlin** — the single Java posting is LATAM-only.
Approval is explicitly demand-gated ("technical skills that match the needs of current
clients"). Leading with "Flutter developer" is the fastest route to a February 2027 lockout.

**First action:** position the profile around his LLM-agent work (multi-agent email
authoring, AI project manager), Python/backend, and code evaluation — then apply to
*Agentic AI Software Engineer (AI Training)*, which has 1,000 open seats. $30–55/hr,
20 hrs/week. That is demand that provably exists.

### 4. Apply to **YunoJuno** (45 min)

The original sweep said "recommend against"; verification reversed it. There is no
mid-to-senior gate in current docs — only "we review every profile individually, up to
7 days" and **one** reference minimum (not three). 0% commission, no bid quota, no
application cap. International contractors are paid **via Wise**, which pays INR to Indian
banks. An Indian sole proprietorship satisfies their "business structure recognised in your
country of residence" rule; the Amiqus check for non-UK contractors is ID + selfie only.

**The payoff:** approved contractors get a **personal RSS feed of profile-matched jobs**,
explicitly documented for automation. That is a machine-readable, unmetered, 0%-commission
job feed — the best structural answer to his constraint in this report. Unproven for volume
of Spring/Flutter work reachable from India; that is the real risk, not the experience bar.

**First action:** apply, lead with the 5-person team lead and the quantified wins, add 2–3
references rather than the minimum one.

### 5. Arc.dev profile (1 hour) — low volume, but free and already scraped

Free, verbatim: "no cost to use the platform nor when you land a job through Arc." 22 of 30
live roles are India-eligible. Listings are genuinely fresh (median age 9 days). But the
pool is small and skewed: `/remote-jobs/java` returns 2 jobs, the one true Spring Boot role
is geo-blocked to NA/LATAM, `/remote-jobs/kotlin` returns 0, `/remote-jobs/react` returns 22.
Expect **1–2** applicable roles live at any moment. His best current target there is the one
*Senior Full Stack Developer (Flutter/Firebase) WW* role at $35–55/hr.

**Deliberately not in the top 5:** Toptal (3–8 weeks, 3% pass rate, 1–3 week unpaid test
project — worth one attempt but never block on it), Turing / Uplers / Flexiple (all
full-time-job pipelines requiring 40 hrs/week, they do not supplement his Longfloat role,
they replace it), Upwork (see §4 — only if he is spending money, and Freelancer is cheaper).

---

## 2. Full comparison table

| Platform | India | Cost to apply | Experience bar | Stack fit | Payout | Automatable | Verdict |
|---|---|---|---|---|---|---|---|
| **Freelancer.com** (baseline) | Yes | 6 bids free; **₹799 Plus = 100 bids, 1st month free**; ₹399 Basic = 50 | None | Broad but price-compressed. 450 queued, 123 ≥$400 | 10% or ₹250 floor. **Free INR local bank deposit**. Min withdrawal $50 | **Y** — open gig API, rig already built | **Buy it.** §4 |
| **Braintrust** | Yes (17/126 postings list IN) | $0. No bids/connects/cap | Low — 5-10 min non-technical AI screen, 3 business days. **6-month lockout if rejected** | **0 Flutter, 0 Spring, 0 Android.** 4 India-eligible eng roles, all AI-training, $28-55/hr | Talent keeps 100%; 15% charged to client. INR to Indian bank or USDC. Pass-through, not escrow — 2-6 wk cycles | **Y** — `app.usebraintrust.com/api/jobs/` no auth | Apply, positioned as AI/LLM. Not a Flutter channel |
| **Arc.dev** | Yes — 22/30 roles | $0, verbatim | "5+ yrs do best" = preference not gate. 24 senior / 6 mid / 0 junior live | Thin. Java=2 (1 geo-blocked), Spring Boot=1 (geo-blocked), Flutter=1 real, Kotlin=0 | Sets own rate, $30-55/hr median band. **Rails to India unconfirmed** | **Y** — `__NEXT_DATA__` → `arcJobs[]`, has `requiredCountries` | Cheap background feed. 1-2 hits at a time |
| **YunoJuno** | Provided for (Wise payout, intl ID check). India never named — unconfirmed | $0, 0% commission, no cap | No stated seniority gate. 1 reference min. 7-day review | "Developer" is a real category. UK/EU enterprise clients. **Volume for his stack unconfirmed** | 0% cut. Wise → INR. Paid within 14 days of timesheet approval | **Y after approval** — personal RSS feed, documented for automation | Apply. Best structural fit if the feed carries work |
| **Upwork** | Yes, fully | 10 free Connects/mo is a **promo he may not get**; bonus is 12 Connects for 54 spent, A/B tested. Plus ≈$20/mo = 100 Connects (price now in-app only) | None formal; zero-history profiles structurally deprioritised | **Deepest real Spring Boot / microservices / Android-NDK demand anywhere in this report** | **0–15% variable per contract**, not 10% flat. **$0.99 IFSC transfer to Indian bank — best in category** | **Y** — official OAuth2 GraphQL API, `node-upwork-oauth2` SDK. RSS feed is **410 Gone** | Only if paying. Freelancer Plus is cheaper per bid |
| **Contra** | Yes (1,593 India hire pages) | $0, 0% freelancer commission. Free tier "Limited job opportunities" — **number unpublished**. Pro $29/mo | None | Design-first. Flutter 113 / Android 133 taxonomy pages; **Spring Boot 15, effectively no Java demand** | 0% to him. Client pays flat $15 (<$500) or $29 (≥$500). Payoneer $3+1-2%, FX 1% on INR | Playwright only. No API — probed 8 paths, all 404 | Sign up free. **Mobile play, not backend.** Don't pay $29 blind |
| **Toptal** | Yes, no restriction | $0, 0% cut | "2-3 yrs" stated — he clears the floor. 3% pass rate, 3-8 weeks, **1-3 wk unpaid test project** | Java/Spring real and visible. **Flutter page has zero postings** | Sets own rate. $60-200/hr is the **client** price; ~50% markup, talent clusters far lower. Rails unconfirmed | N — membership-gated (public listings do render to a browser, but applying needs membership) | One serious attempt. Sell Java, not Flutter. Expect sub-$60/hr |
| **Turing** | Yes, India-founded | $0 | ~5h assessments. 45-day lockout on coding challenge, 90-day on others | Pivoted to LLM-training "data refinery". Modal outcome is RLHF/eval work | Monthly USD via Deel. India median ≈$31k/yr, **not** the $129k figure. One documented $13/hr offer | N — JS shell, no API, push-based | Background bet only. **40 hrs/wk + 4h Silicon Valley overlap.** Documented "assigned but idle" dead-bench |
| **Uplers** | **Required** — India-exclusive by design | $0. **3 mandatory assessments, 2-month lockout on failure** | Sells 1-2 yr band to clients; visible bench is 4-18 yrs. Assessments are the real filter | Java + Android are first-class categories, but current taxonomy skews AI/GenAI. **Lead with LLM-agent work** | Their EOR handles it. **Currency/rails not published.** Client price from $2,500/mo | N — login-gated SPA. (Their roles do appear on Naukri/LinkedIn, scrapable as employer query) | Full-time placement, 3-mo min, 8h/day, **contractual notice period**. Job change, not side income |
| **Flexiple** | Yes — India *is* the product | $0, 0% commission | **Unconfirmed** — the 3-yrs/5%/6-stage figures trace to a domain that does not resolve. First-party docs state no bar | Sample roles are Python/React/TS. **Java/Flutter/Android are SEO nav with no live roles.** Spring Boot page is a soft-404 | **NEFT direct to Indian bank**, 18% GST, 194J TDS. No FX loss. 100% payment guarantee | N — 0 JSON-LD postings. **Blacklist** `app.flexiple.com/api/jobs` and `flexiple.com/jobs/rss.xml`: both return 200 serving HTML | 1 hour: form + one intro call. Mention the LeetCode volume (proctored-DSA eval) |
| **Hubstaff Talent** | Yes, `/country/india` page | $0 forever. No quota of any kind | None visible | **~10-20 relevant jobs on the whole board.** 199,036 profiles vs 700 open jobs. VA/appointment-setting at $4-10/hr | No escrow, no payment processing. Invoice direct, **he carries 100% counterparty risk** | Technically yes (`/search/jobs?search[keywords]=`, Vue-rendered, 429s after ~5 rapid reqs) — **not worth it** | 45-min profile, then ignore. Lottery ticket |
| **Workflexi** | Yes — India-exclusive | $0 claimed, zero commission (primarily a *hirer*-side claim) | None | Java/Spring Boot landing pages exist; **live gig volume unmeasured** | Razorpay → INR, milestone/wallet escrow. Timing unconfirmed | Y post-login — Angular SPA + REST at `login.workflexi.in/workflexi-api`, JWT via `/authenticate` | **60-min probe, hard time-box.** App frozen since Dec 2024; ToS is copy-pasted Upwork text with 54 links still pointing at upwork.com |

---

## 3. Automate these

Four verified sources, probed today. All fit the existing
`{ title, company, url, text, skills[], location, budget, type, posted }` contract.

### 3.1 Braintrust — best of the four

```
GET https://app.usebraintrust.com/api/jobs/          → 200 application/json, DRF-paginated
GET https://app.usebraintrust.com/api/jobs/?page=N   → 20/page, count:126 today
GET https://app.usebraintrust.com/api/jobs/<id>/     → full detail
```
No auth, no cookies, no headers. **Do not** use `/api/talent/jobs/` (401) or
`/api/public/jobs/` and `/api/marketplace/jobs/` — those return 200 serving the SPA HTML
catch-all. Check `content-type`, not status code.

Record: `id, title, employer{name}, role{}, job_type, contract_type, payment_type,
budget_minimum_usd, budget_maximum_usd, expected_hours_per_week, openings_left,
main_skills[], job_skills[], locations[] (country codes), timezones[], created, deadline`.

Mapping: `budget` ← `budget_minimum_usd`-`budget_maximum_usd`; `skills` ← `main_skills`
+ `job_skills`; `location` ← `locations[].country`; `posted` ← `created`.
Filter: `locations[]` empty OR contains India. Drop `job_type === 'direct_hire'` (15 of 126
are permanent placements, not gigs). ~3-4 new postings/day platform-wide — poll daily.

### 3.2 Arc.dev — the only source with a machine-readable India flag

```
GET https://arc.dev/remote-jobs/java     (also /flutter /android /spring-boot /kotlin /react /nodejs)
→ parse <script id="__NEXT_DATA__" ...>  → props.pageProps.arcJobs[]
```

Two gotchas that will silently break a naive scraper — both confirmed today:

1. The tag is `<script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous">`.
   A regex ending in `type="application/json">` **will not match**. Use:
   `/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/`
2. `postedAt` is a **Unix epoch in seconds as an integer** (e.g. `1784934544`), not ISO-8601.

Record: `title, jobType, jobRole, experienceLevel, requiredCountries[] (ISO-2),
minHourlyRate, maxHourlyRate, minAnnualSalary, maxAnnualSalary, urlString, postedAt,
company{}, categories[]`.

**Iterate the per-skill URLs, not `/remote-jobs`.** Per-skill pages return Arc jobs absent
from the main page — it is the only way his stack ever appears. `?page=2` returns a
byte-identical payload (client-side pagination), so paging is pointless. Also present in the
same payload: `externalJobs[]` and `totalExternalJobCount` (747 today) — **ignore both**,
they are aggregated third-party postings that overlap the boards he already swept.

India filter: `requiredCountries.length === 0 || requiredCountries.includes('IN')`.
Confirmed working: the live Senior Java/Spring Boot role lists 36 NA/LATAM codes with no `IN`.

### 3.3 Torre

```
POST https://search.torre.co/opportunities/_search/?offset=0&size=20&aggregate=false
Content-Type: application/json
{"skill/role":{"text":"flutter","experience":"potential-to-develop"}}
```
Returns `{total: 301, results:[{id, objective, slug, tagline, compensation{}, remote, ...}]}`.

Two hard-won gotchas: the **trailing slash on `_search/` is mandatory**, and the
**`experience` key is mandatory** — omit either and it fails. URL is
`https://torre.ai/post/<slug>`. Expect LATAM salaried roles at LATAM rates: filter
client-side on `remote === true` and a compensation floor.

### 3.4 Jobgether

```
GET https://jobgether.com/astroapi/ai/jobs?keyword=flutter
```
Explicitly `Allow:`-ed in their robots.txt (`Allow: /astroapi/ai/jobs?*`) with
`Crawl-delay: 2`. Note the param is **`keyword`**, not `search` — `search=` returns
unfiltered results, which is exactly the silent-junk-scrape failure mode in his ATS memory
note. Also note `POST /api/v1/offers/search` → **403**; that path is wrong.

Record: `id, title, company, url, location, remote, contractType, experience,
jobFunctions[], postedAt` (ISO-8601 here). `contractType` is overwhelmingly `"Full time"`,
so this feeds the salaried pipeline more than the contract one — but it is the one source
that returned an India-located Flutter job.

### Also worth registering (10 min each, not probed today)

- **Adzuna** `api.adzuna.com/v1/api/jobs/in/search/1?app_id=&app_key=` — the only India-native
  structured API with explicit `contract_type` / `contract_time` facets. Credentials go in
  the query string, no OAuth.
- **Upwork GraphQL** `https://api.upwork.com/graphql` — live (returns 401, not 404), OAuth2,
  official `node-upwork-oauth2` SDK matches his stack (last updated 2024-11, so ~20 months
  stale). Read-only job search is in active third-party use. Whether the terms permit
  automated *proposal submission* is **unconfirmed** — developers.upwork.com 403s.

### Output sink

Point the pipeline at a **Discord webhook**. One POST, no auth beyond the secret URL, phone
notifications. Discord is a bad ingestion source (needs per-server admin) but an ideal sink.

### Explicitly blacklist — these return HTTP 200 serving junk

| URL | What it actually returns |
|---|---|
| `app.flexiple.com/api/jobs` | 200, SPA HTML shell |
| `flexiple.com/jobs/rss.xml` | 200, marketing homepage |
| `app.usebraintrust.com/api/public/jobs/` and `/api/marketplace/jobs/` | 200, SPA catch-all |
| `jobgether.com/astroapi/ai/jobs?search=` | 200, **unfiltered** results |
| `hubstafftalent.net/search/jobs?q=` | 200, silently ignores `q`, returns everything |
| `guru.com/d/jobs/...` | 200, 850-byte Incapsula block page |
| `upwork.com/ab/feed/jobs/rss` | **410 Gone** — permanently retired |
| `flutterjobs.info` | alive but frozen ~2020; would inject 6-year-old listings |

---

## 4. The Freelancer.com decision

**Buy it. Specifically: start the Plus free trial tonight, then drop to Basic at ₹399/mo.**

The premise of "should I migrate off Freelancer.com" does not survive contact with the
price list. He is not stuck behind a quota — he is stuck behind ₹0, then ₹399.

### What is actually in the queue

I measured `apply-queue.json` (450 items, 444 with a parseable bid) rather than assuming.
Converted to USD at current rates:

| Percentile | Value |
|---|---|
| p10 | $12 |
| p25 | $21 |
| **median** | **$151** |
| p75 | $525 |
| p90 | $1,163 |
| p95 | $2,976 |
| p99 | $12,657 |

| Band | Count |
|---|---|
| under $50 | 157 |
| $50–150 | 61 |
| $150–400 | 103 |
| $400–1,000 | 71 |
| $1,000–3,000 | 30 |
| $3,000+ | 22 |

**Correction to the brief:** the stated "$400–14,000 realistic value band" is really the
p72–p99 slice. 35% of the queue is under $50 and half is under $151. 216 of 444 are
INR-denominated with a **median of $86** versus $151 for non-INR — the Indian-domestic
clients pay roughly half. He should not bid the whole queue; he should bid the top of it.

**The real target set: 52 gigs with value ≥ $400 and fit ≥ 120.** Median of the ≥$400
subset is $663, mean $2,483 (mean is dragged by a $15.5k SaaS marketplace and a $12.7k
multi-platform build, both genuine Flutter/Spring fits). Total notional across all 444:
$338,711 — meaningless as a forecast, useful only as evidence the pipeline is not junk.

### Break-even

Basic is ₹399/mo ≈ $4.55 for 50 bids ≈ **₹8 per bid**. Commission stays 10% (with a ₹250
floor on his India account, not the $5 USD floor — so a $40 job loses ~7%, not the 12.5% a
USD-denominated account would).

- One win at the ≥$400 median of $663 nets ~$597 after commission = **131× the monthly fee**.
- Break-even is a single **$5** project. The fee is not a decision, it is a rounding error.
- Required win rate to break even on 50 bids: **0.0007 wins** — i.e. functionally zero.

The fee is not the cost. **The cost is his time.** 52 genuine proposals at ~10 minutes of
review each is ~8 hours. At a conservative 3% win rate that is 1.6 wins × $663 = ~$1,060,
or **~$130/hr on the time spent**. At 2% and only the median job, ~$85/hr. Both beat every
other channel in this report on time-to-first-rupee by weeks.

### Which tier

- **Month 1: Plus, free trial, 100 bids.** Covers the 52-gig target set plus 48 more.
- **Month 2 onward: Basic ₹399 = 50 bids.** 50/month is roughly the rate at which
  genuinely-fitting gigs appear; ₹2,999 for 300 bids only makes sense if he is winning
  and needs throughput.
- Do **not** go Professional/Premier. Bid volume is not his bottleneck once he is over ~50.

### Caveats, stated honestly

- **Unconfirmed:** whether paid tiers reduce the 10% commission. The membership page does
  not say. Assume 10% at every tier until he sees otherwise in his own account.
- Minimum withdrawal is **$50** after fees. Small INR jobs will pool before he can pull.
- Freshness is fine: **118 of his 166 Flutter/Spring queued items are still in the live
  active-projects feed** two days on. Bid highest-fit-first anyway — Freelancer projects
  attract 20-50 bids within hours.
- Quota is enforced server-side; API bids consume it identically to UI bids. A paid tier
  raises the ceiling, it does not remove it. His own note stands: the quota is the ceiling,
  not the code.

### Versus Upwork

Upwork is the only platform in this report with genuine enterprise-budget Spring Boot,
microservices and Android-native demand, and its $0.99 IFSC transfer to an Indian bank is
the best payout in the category. But: the free tier is worse than Freelancer's (10 Connects
is a *promotion* he may not be eligible for, and the bonus is 12 Connects for 54 spent,
gated behind an A/B test), the service fee is **0–15% variable per contract** rather than
the 10% flat that is widely repeated, and Plus is ~$20/mo with the price now visible only
in-app. **₹799 for 100 Freelancer bids beats ~$20 for 100 Connects**, especially when his
bidding rig already works there and he would start at zero reputation on Upwork.

Open an Upwork account for the stack depth and the GraphQL API. Do not make it the paid
channel until Freelancer stops converting. If he does subscribe there, pre-authorise the
RBI e-mandate with his bank first — a failed recurring charge can trigger an account hold.

---

## 5. Don't bother

| Platform | Why |
|---|---|
| **Crossover for Work** | Not freelance. 40 hrs/week full-time with mandatory WorkSmart surveillance — 6 "virtual timecards"/hour, webcam shot plus desktop screenshots at random 2-10 min intervals, no documented opt-out. Payment platform locked to Payoneer or Paychex, "not possible to request to change". A job change with a camera on him, not a side channel. |
| **Guru.com** | The stated reason to join was scrapability, and it is false. Behind Imperva/Incapsula: `guru.com/d/jobs/...` returns **HTTP 200 with an 850-byte block page** — the exact silent-junk failure his ATS memory warns about. Even `/robots.txt` is blocked. Strip that away and the offer is 10 quotes/mo vs 6 — four extra bids against a 450-gig backlog. |
| **Twine** | Zero stack demand, measured not inferred. On the live `/jobs` HTML: Flutter **0**, Android **0**, Kotlin **0**, Spring **0**, Java 1 — against Design 266, Video 262. The India page is the same. 9 of 10 rendered listings were video/design. Free tier is 1 pitch/day. The pages he was told to scrape contain no listings. |
| **PeoplePerHour** | Three independent kills. (1) I scraped all 45 pages of technology-programming: **161 unique live jobs total**, of which 3 mention Flutter and **zero** mention Java, Spring, Kotlin, Dart or microservices; 40 say "website", 16 WordPress. (2) **$23.99 flat per bank transfer to India** vs £0 for UK. (3) 20% commission on the first $350 per client, resetting every client — double Freelancer. Plus 1.5/5 on 192 SiteJabber reviews with documented escrow freezes. |
| **Truelancer** | Sold as a quota relief valve; supply is the constraint, not quota. Across 375 live listings from their own API: ~500 projects/month platform-wide, ~7% touch his stack, **~11/month** carry a $300+ budget. Measured hourly median **$5/hr**. Flutter 3, Java/Spring 6, WebRTC 0, Firebase 0 out of 375. He would exhaust the *relevant work* in week one. Fee page is challenge-blocked, so its fee numbers are unverifiable. |
| **Wellfound** | Salaried startup board, not a marketplace. `jobType="contract"` was 1 of 23 on Flutter, 1 of 31 on Java, 2 of 46 on India — 3-5%. Same population that produced his 7-of-875 result. DataDome-protected, so scraping needs paid residential proxies for sub-1% conversion. |
| **Internshala** | Not a freelance platform at all. The string "freelance" appears **zero** times in the HTML of every keyword page tested. `/freelance` is a **404**; `/jobs/freelance-jobs/` 301s to the generic board. What remains is salaried Indian junior roles — Spring Boot listings at ₹2-5.6 lakh/year, a large downgrade on his current job. |
| **Refrens** | Invoicing/accounting/GST SaaS, not a gig source. No browsable feed, nothing to bid on. **Keep the bookmark** — he will need exactly this for GST invoicing and 194J TDS if Flexiple or a direct client starts paying INR. |
| **Lemon.io** | Hard geo-block. Published Asia allowlist is Japan, Singapore, South Korea, Philippines, Indonesia, Malaysia, Vietnam, Thailand. India conspicuously absent from a list specific enough that it is not an oversight. Jurisdictional — no portfolio changes it. |
| **Malt** | Nine European countries + UAE only, with an explicit blocked-countries model. India is not an operating country. **One live angle:** he already works for a Dubai company — if he ever holds a UAE freelance permit, Malt UAE is a strong fit for exactly his Java/Spring profile. |
| **Andela** | Published **4-year minimum**. He has ~2. Applying and being rejected triggers a stated **90-day lockout**, so a speculative shot actively destroys optionality. Revisit early 2028. |
| **Gun.io** | ~10% approval assessed primarily on work history, cohort is 70% at 10+ years, and there is no algorithmic stage where his LeetCode depth can rescue it. Terms are excellent and irrelevant if the gate never opens. |
| **A.Team** | Sub-2% acceptance, explicitly senior/fractional-CTO. Country eligibility undocumented. Revisit at 5 years. |
| **Codeable** | WordPress/PHP only, ~2% acceptance, 4-week application. Total stack mismatch — even if he passed there is nothing for him to build. |
| **UpStack** | Country eligibility, developer pay share and payment method are all unpublished — I confirmed the omission is real by fetching their FAQ, where Geography and Invoicing render as **empty headers**. If curious, one email answers both before a 1-3h coding challenge. |
| **Pesto Tech** | Pivoted to employer-side recruiting tooling. **Hard rule: do not sign anything resembling their legacy Income Share Agreement** — 17% of income for 36 months is the most expensive arrangement in this entire report, worse than any commission here. |
| **Deel Talent** | Employer-side sourcing funnel fed by agencies; no self-registration path. **Keep Deel as infrastructure** — free contractor tooling, India corridor at ~0-3% FX markup, better than Payoneer's spread — for when he lands a direct client. |
| **Workana** | LATAM platform, 20% entry commission, free bid allowance is an unpublished reputation-gated variable that starts at the floor. No confirmed INR path. Worse than Freelancer on every axis. |
| **Freelance.com** | French enterprise staffing/portage-salarial group. 820KB of French-language corporate content. Not joinable. |
| **Worknrby / WorknHire / Expertlancer** | Dead. Cloudflare 522 with a 16-byte body; `worknhire.com` no response at all; `expertlancer.com` 302s to a domain-for-sale listing and `.in` does not resolve. |
| **Kolabtree** | PhD-scientist marketplace. Nothing on it he can build. |
| **r/forhire, r/freelance_forhire** | 0 Flutter, 0 Java, 0 Spring, 0 Android across a 100-post sample. 52% of posters are competing freelancers. Automation blocked three ways (403 JSON, 403 RSS, PullPush dead since May 2025). *(r/jobbit is marginally better — Java appears 9× per 100 posts — but ~7.6 hiring posts/day total; 10 min/day skim at most.)* |
| **The Muse / Remote.co / Pangian / hnhiring.com** | Muse and Remote.co are salaried US inventory of exactly the shape already exhausted. Pangian appears defunct. hnhiring.com is a strictly worse HTML mirror of data the HN Algolia API hands over as JSON, keyless, 10k req/hr. |
| **Google Custom Search API** | Dead end twice: closed to new customers, and retiring 2027-01-01. For a careers-page sweep use direct ATS board APIs (Greenhouse / Lever / Ashby / Workable) instead. |
| **Udemy, CodeCanyon, Gumroad, Medium, Ko-fi, HackerOne** | All 6-18 month payoffs at best. Udemy is the worst hours-to-rupees trade here: 150-300 hours to produce a course for a realistic $20-200/month year one in a saturated Flutter category. GitHub Sponsors (0% for personal accounts, confirmed India) dominates Ko-fi/BMaC. Bug bounty is 6-12 months to a first paid report for a backend engineer starting appsec cold. |
| **LogRocket guest authors** | Verified **closed**: "We're not accepting new applicants for our guest author program at the moment." |

---

## 6. Positioning note

### He is not a Flutter developer

The single biggest correction this research produced: **his stack is asymmetric, and which
half he leads with should change per platform.** Across everything measured:

- **Spring Boot / Java demand exists** on Upwork, Toptal and Freelancer. It is **absent**
  from Braintrust (0), Contra (15 SEO pages), Twine (0), Truelancer (6 of 375), PPH (0 of
  161), and **geo-blocked to NA/LATAM** on Arc.
- **Flutter / Android demand exists** on Freelancer (101 of his 450 queue items),
  Contra (113 Flutter + 133 Android taxonomy pages), Arc (1 role), Uplers. It is **absent**
  from Toptal (Flutter page has zero postings), Braintrust (0), Twine (0), PPH (3).

So: **lead Java/Spring on Toptal and Upwork. Lead mobile on Contra and Freelancer. Lead
neither on Braintrust — lead LLM-agent and code-evaluation work there**, because that is
the only demand on that board and rejection costs 6 months.

### The actual pitch

He is a **backend engineer who also ships native-grade mobile** — a combination that is
rare and that neither a Flutter shop nor a Java shop can hire in one person. The proof
points, in descending order of persuasiveness:

1. **Numbers, not tenure.** Crash-free rate 67% → 94%. Google Maps API cost −85%. UI frame
   drops −40%. Crashes −35%. Nobody with two years of experience has these because most
   two-year engineers never own a metric. Open with them.
2. **Volume of shipped product.** 9+ production Flutter apps, including two ride-hailing
   apps (rider + captain). That beats "3 years experience" on every screen that weighs
   "complexity of products built" — which is explicitly how Flexiple, Arc and YunoJuno
   review.
3. **Team lead of 5.** Turns a junior résumé into a senior-adjacent one on any human review.
4. **The rare skills: Android NDK/JNI + C++, and WebRTC.** This is his real moat. Almost no
   Flutter freelancer can debug a JNI boundary or a TURN/ICE failure. Everyone can build a
   CRUD screen. Every gig that mentions video calling, real-time audio, or native
   performance should get a bid regardless of the other filters.
5. **400+ LeetCode/Codeforces.** Only mention it where there is an algorithmic screen —
   Toptal (3 questions, ~210/300 to pass), Turing, Flexiple's proctored DSA, Braintrust's
   code-evaluation roles. It is invisible everywhere else.

Do **not** lead with "~2 years experience" anywhere. It is true, it is not a lie of
omission to place it after the metrics, and every network in this report that stated a bar
stated it as a preference with two exceptions (Andela's hard 4 years, and Arc's soft 5).

### Realistic hourly-rate bands

An India-based engineer with ~2 years and no Western platform reputation. These are what he
should *expect to be offered*, not what the platforms advertise.

| Tier | Band | Notes |
|---|---|---|
| Indian-domestic marketplaces (INR gigs on Freelancer, Workflexi, Truelancer) | **$5–15/hr** | Truelancer's measured median is **$5/hr**. The INR half of his own queue has a median project value of $86. Take these only for volume, reviews, or when the brief is genuinely 2 hours of work. |
| Open marketplaces, Western clients (Freelancer USD gigs, Upwork, Contra) | **$20–30/hr** starting, **$30–45** after 3–5 good reviews | Zero reputation is the constraint, not skill. The first 2-3 jobs are priced to buy reviews. |
| Vetted networks (Arc, Braintrust, Turing) | **$28–55/hr** | Arc's live engineering median band is $30–55. Braintrust's India-eligible AI-training engineering roles are $28–55. Turing anchors low — one documented $13/hr offer to an India-based dev; **negotiate, and do not accept the first number**. |
| Toptal / premium networks | **$40–60/hr realistic** | The advertised $60–200/hr is the **client** price with a ~50% markup on top. Self-reported talent rates cluster far below: a Java dev with 8 years in Eastern Europe at $50/hr, an ex-Amazon SDE2 at $50/hr. At 2 years, expect the bottom of that. |
| Direct clients / agency subcontracting on the NDK+WebRTC niche | **$40–80/hr** | No platform cut, no quota, and the scarcity is real. This is the highest ceiling available to him and the only one that compounds — each engagement is a case study that raises the next rate. It is also the slowest to start: 3-6 weeks of consistent outreach before first revenue, and the documented failure mode is 30 outreaches in week 1, 10 in week 2, 3 in week 3, quit. ~50 targeted sends/week at ~3-4 hrs is the right dose. Target agency delivery/engineering leads, not HR. |

### The one thing that is honestly three months out

Publishing a genuinely useful Flutter/Dart package on **pub.dev** — ideally in his WebRTC or
NDK niche, where almost nothing good exists. Direct revenue is approximately **zero**
($0–50/month even for a decent package). Time to first inbound consulting enquiry is
**4–9 months**. Cost is 20–40 hours. It is on this list for exactly one reason: it is the
only asset here that requires no application, no fee, no geo check and no quota, and one
inbound WebRTC contract at $50–80/hr repays the entire year. Start it when the bidding is
running itself, not before.
