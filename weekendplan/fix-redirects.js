#!/usr/bin/env node
/*
 * fix-redirects.js — resolve the 53 redirecting domains found by verify-domains.
 *
 * Three different situations hide behind "this domain redirects somewhere else",
 * and they need opposite treatment, so each entry below is decided explicitly
 * rather than by rule:
 *
 *   LEAVE  the redirect is an artefact, not a move — a Radware/PerfDrive bot
 *          challenge, or a regional subdomain (hm.com -> www2.hm.com). The
 *          domain is correct and must not be touched.
 *   UPDATE the company was acquired or rebranded and STILL hires in India.
 *          Both the site and the name have to change: the scanner validates a
 *          job board by checking the company name appears inside the board's
 *          own name, so an entry still called "Quizizz" can never match a board
 *          that now says "Wayground". These are the valuable ones — each is a
 *          live employer currently producing nothing.
 *   DROP   the domain no longer belongs to anyone related. Accord Software's
 *          is parked on Sedo, Logiticks' now serves an Indonesian lottery site,
 *          Quovantis' an addiction-recovery clinic. Keeping these risks pulling
 *          a stranger's pages in under an Indian software company's name.
 *
 * Names are written "NewBrand (formerly OldBrand)" so the old name stays
 * readable in the report — slugs() strips parenthesised text, so the board
 * check still matches on the new brand alone.
 *
 *   node weekendplan/fix-redirects.js          # dry run
 *   node weekendplan/fix-redirects.js --apply
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const APPLY = process.argv.includes('--apply');

// site -> { site, name } | 'DROP' | 'LEAVE'
const PLAN = {
  // --- artefacts: bot walls and regional subdomains. The domain is fine. ---
  'federal.bank.in': 'LEAVE',
  'kotakmf.com': 'LEAVE',
  'mediaagility.com': 'LEAVE',
  'persistent.com': 'LEAVE',
  'universalsompo.com': 'LEAVE',
  'hm.com': 'LEAVE',
  'pg.com': 'LEAVE',

  // --- domain no longer related to the company ---
  'accordsoft.com': 'DROP',        // parked on Sedo
  'logiticks.com': 'DROP',         // now an Indonesian lottery site
  'quovantis.com': 'DROP',         // now an addiction-recovery clinic
  'betterhalf.ai': 'DROP',         // bounces to a Play Store listing, no site

  // --- acquired or rebranded, still hiring in India ---
  'ltimindtree.com': { site: 'ltm.com', name: 'LTM (formerly LTIMindtree)' },
  'quizizz.com': { site: 'wayground.com', name: 'Wayground (formerly Quizizz)' },
  'qualitestgroup.com': { site: 'quality-ai.com', name: 'QualityAI (formerly Qualitest)' },
  'lambdatest.com': { site: 'testmuai.com', name: 'TestMu AI (formerly LambdaTest)' },
  'teleperformance.com': { site: 'tp.com', name: 'TP (formerly Teleperformance)' },
  'jaguarlandrover.com': { site: 'jlr.com', name: 'JLR (Jaguar Land Rover)' },
  'nxtwave.tech': { site: 'ccbp.in', name: 'NxtWave CCBP' },
  'fampay.in': { site: 'famapp.in', name: 'FamApp (formerly FamPay)' },
  'alphagrep.com': { site: 'alpha-grep.com', name: 'AlphaGrep' },
  'moneytap.com': { site: 'freo.money', name: 'Freo (formerly MoneyTap)' },
  'mobisy.com': { site: 'bizom.com', name: 'Bizom (Mobisy Technologies)' },
  'legatohealthtech.com': { site: 'carelon.com', name: 'Carelon (formerly Legato Health)' },
  'onlinesales.ai': { site: 'osmos.ai', name: 'Osmos (formerly Onlinesales.ai)' },
  'roambee.com': { site: 'decklar.com', name: 'Decklar (formerly Roambee)' },
  'ugamsolutions.com': { site: 'merkle.com', name: 'Merkle (formerly Ugam)' },
  'yuhu.io': { site: 'happy.co', name: 'HappyCo (formerly Yuhu)' },
  'altair.com': { site: 'siemens.com', name: 'Siemens (Altair)' },
  'apisero.com': { site: 'nttdata.com', name: 'NTT Data (Apisero)' },
  'accolite.com': { site: 'bounteous.com', name: 'Bounteous (Accolite Digital)' },
  'listertechnologies.com': { site: 'bounteous.com', name: 'Bounteous (Lister Technologies)' },
  'ameexusa.com': { site: 'perficient.com', name: 'Perficient (Ameex)' },
  'altencalsoftlabs.com': { site: 'acldigital.com', name: 'ACL Digital (ALTEN Calsoft Labs)' },
  'doubtnut.com': { site: 'allen.in', name: 'Allen (Doubtnut)' },
  'vitechinc.com': { site: 'majesco.com', name: 'Majesco (Vitech)' },
  'varian.com': { site: 'siemens-healthineers.com', name: 'Siemens Healthineers (Varian)' },
  'xandr.com': { site: 'microsoft.com', name: 'Microsoft Advertising (Xandr)' },
  'igtsolutions.com': { site: 'atain.com', name: 'Atain (formerly IGT Solutions)' },
  'infibeam.com': { site: 'avenuesai.com', name: 'AvenuesAI (formerly Infibeam)' },
  'ineuron.ai': { site: 'pwskills.com', name: 'PW Skills (formerly iNeuron)' },
  'agiratech.com': { site: 'busofttech.com', name: 'BuSoft (formerly Agira)' },
  'altiux.com': { site: 'prasadityaidea.com', name: 'Prasaditya IDEA (Altiux)' },
  'avantorsciences.com': { site: 'vwr.com', name: 'Avantor VWR' },
  'go-db.com': { site: 'insillion.com', name: 'Insillion (GoDB Tech)' },
  'jivox.com': { site: 'davincicommerce.ai', name: 'DaVinci Commerce (Jivox)' },
  'ladybirdweb.com': { site: 'faveohelpdesk.com', name: 'Faveo Helpdesk (Ladybird Web)' },
  'logicladder.com': { site: 'thesustainabilitycloud.com', name: 'The Sustainability Cloud (LogicLadder)' },
  'netsurion.com': { site: 'lumificyber.com', name: 'Lumifi (formerly Netsurion)' },
  'techcurve.in': { site: 'grctechx.com', name: 'GRCTechX (formerly Techcurve)' },
  'xsell.ai': { site: 'attune.ai', name: 'Attune (formerly XSELL)' },
  'yieldstreet.com': { site: 'willowwealth.com', name: 'Willow Wealth (Yieldstreet)' },
  'yousign.com': { site: 'youtrust.com', name: 'Youtrust (formerly Yousign)' },
};

const bare = (s) => String(s || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();

let updated = 0;
let dropped = 0;
let left = 0;
const log = [];

for (const L of 'abcdefghijklmnopqrstuvwxyz'.split('')) {
  const f = path.join(ROOT, L, 'companies.js');
  if (!fs.existsSync(f)) continue;
  const arr = require(f);
  const out = [];
  let touched = false;

  for (const c of arr) {
    const plan = PLAN[bare(c.site)];
    if (!plan) { out.push(c); continue; }
    if (plan === 'LEAVE') { left++; out.push(c); continue; }
    if (plan === 'DROP') {
      dropped++;
      touched = true;
      log.push(`  DROP    ${L}  ${c.name}  (${bare(c.site)})`);
      continue;
    }
    updated++;
    touched = true;
    log.push(`  UPDATE  ${L}  ${c.name}  ${bare(c.site)} -> ${plan.site}  as "${plan.name}"`);
    // Drop the stale careers URL too — it points at the old domain.
    out.push({ name: plan.name, country: c.country, site: plan.site });
  }

  if (touched && APPLY) fs.writeFileSync(f, 'module.exports=' + JSON.stringify(out, null, 1) + ';\n');
}

console.log(log.sort().join('\n'));
console.log(`\n  updated ${updated}   dropped ${dropped}   left alone ${left}`);
if (!APPLY) console.log('\n  dry run — re-run with --apply');
