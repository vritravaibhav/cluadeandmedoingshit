# india/ — every India software role, by stack

## Why this exists

The per-letter folders (`w/`, `x/`, `y/`) sweep companies whose name starts with
one letter. That is structurally too small. Across all 125 "W" companies:

```
964 India roles → 233 engineering → 126 non-senior → 74 at ~2 yrs → 8 Java/Flutter
```

One initial is about 4% of the market, and it excludes employers by
construction — Oxane Partners (a Gurgaon Java shop on Zoho Recruit) could never
appear, because it starts with O.

This folder searches by **stack across every Indian employer at once**.

## The pieces

| file | what it does |
|---|---|
| `crawl.js` | walks the whole Instahyre catalogue in resumable slices |
| `report.js` | rebuilds `india.txt` from whatever has been collected |
| `watch.sh` | one crawl slice, safe to run from a scheduler |
| `store.json` | the accumulated roles (grows, deduped by id) |
| `crawl-state.json` | the checkpoint: which pass, which offset |
| `india.txt` | the human-readable report |
| `sources.js`/`test.js` | the earlier per-skill sweep, kept for one-off stack queries |

## Running it

```bash
node crawl.js                 # one 120-page slice, then stop
node crawl.js --budget=420    # a whole pass (~9 min)
node crawl.js --push          # commit + push when the slice adds anything
node crawl.js --status        # where am I
node crawl.js --reset         # start a fresh pass (store is kept)
node report.js                # rebuild india.txt without refetching
```

## It is built to be interrupted

Every slice writes its position to `crawl-state.json` before exiting, via a
temp-file rename so a kill mid-write cannot corrupt it. Run it again and it
resumes at the exact offset. Nothing is lost to a kill, a rate-limit, a closed
laptop, or a scheduler that fires while the last one is still going.

This is also the answer to "pause when usage gets high": **no model is involved
in the crawl at all.** `watch.sh` is plain shell calling plain node, so it costs
zero Claude usage however often it runs. There is nothing to throttle.

## The scheduler

Installed as a LaunchAgent, not cron — modern macOS gates `crontab` behind Full
Disk Access and the command simply hangs.

```bash
launchctl list | grep indiacrawl        # is it registered
tail -f watch.log                       # what it has been doing
launchctl unload ~/Library/LaunchAgents/com.longfloat.indiacrawl.plist   # stop
launchctl load   ~/Library/LaunchAgents/com.longfloat.indiacrawl.plist   # start
```

It fires every 15 minutes and does 60 pages. `watch.sh` holds a lock directory
so a slow run never overlaps the next tick, and breaks its own lock if a run was
killed more than 30 minutes ago.

## Git

Commit and push are deliberately separate. Committing is local and always
works; pushing needs credentials the scheduler may not reach. So a slice always
commits, then tries to push — and if the push fails the commits simply queue and
go out on a later tick. Progress is never tied to the network.

If pushes start stalling, it is the macOS keychain wanting authorisation. Push
once by hand (`git push`) and pick **Always Allow**.

## Why it crawls in shards

A single query cannot page past about **9,800 results**, but the catalogue is
about **14,000**. The first version walked the unfiltered list, hit that ceiling,
read the response as "end of list", marked the pass complete and started again
from zero — three times over, always re-covering the same first 70%. The tail
was unreachable by construction, so "100% coverage" was impossible no matter how
long it ran.

So it now walks **77 shards**: the unfiltered list, then one per skill, then one
per city. Every shard is small enough to walk end to end, and the store is
deduped by job id, so heavy overlap between shards costs nothing and is exactly
what makes the union complete. A shard that hits the ceiling is recorded in
`crawl-state.json` under `capped` — that is the signal it needs a narrower
filter.

`skills=` is verified to filter. `locations=` was inferred and could not be
checked while the source was rate-limiting, so the crawler tests it at runtime:
if a filtered shard reports exactly the unfiltered total, the filter is being
ignored, and that whole facet is dropped for the pass rather than silently
re-walking the same list.

## Two limits worth knowing

**No experience field.** Instahyre publishes title, company, location and skill
tags — but not the description and not years-of-experience, and its job pages
return 403 to scripts. So "at my level" in the report means *the title does not
say senior/lead/principal*. A role titled "Software Engineer" that actually
wants six years will still be listed. Open the link before writing anything
tailored to it.

**Rate limiting looks like success.** The API returns **429 with an empty body**,
which parses as "no results". An early version silently recorded `0` for seven
skills that have thousands of roles. `crawl.js` backs off on 429 and reports
partial reads rather than treating them as empty.
