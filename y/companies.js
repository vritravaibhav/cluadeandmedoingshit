







































// 100 companies whose name starts with "Y".
// India-based / India-hiring companies are listed first (priority per request).
//
// Fields:
//   name    - display name
//   country - HQ / primary hiring geo
//   site    - primary domain (used to auto-derive careers URL candidates)
//   careers - known careers page (optional; discovery also guesses)
//   ats     - known ATS hints: { type, token, host?, site? } (optional; discovery verifies/overrides)

module.exports = [
  // ---------------------------------------------------------------- INDIA (1-38)
  { name: 'Yellow.ai',                     country: 'India', site: 'yellow.ai',                careers: 'https://yellow.ai/careers/', ats: { type: 'zohorecruit', host: 'https://careers.yellow.ai' } },
  { name: 'Yubi (CredAvenue)',             country: 'India', site: 'go-yubi.com',              careers: 'https://www.go-yubi.com/careers/', ats: { type: 'zohorecruit', token: 'go-yubi', host: 'https://go-yubi.zohorecruit.in' } },
  { name: 'Yatra Online',                  country: 'India', site: 'yatra.com',                careers: 'https://www.yatra.com/corporate/careers' },
  { name: 'YES Bank',                      country: 'India', site: 'yesbank.in',               careers: 'https://www.yesbank.in/about-us/careers' },
  { name: 'YASH Technologies',             country: 'India', site: 'yash.com',                 careers: 'https://www.yash.com/careers/' },
  { name: 'Yotta Data Services',           country: 'India', site: 'yotta.com',                careers: 'https://yotta.com/careers/', ats: { type: 'darwinbox', token: 'yotta' } },
  { name: 'Yulu Bikes',                    country: 'India', site: 'yulu.bike',                careers: 'https://www.yulu.bike/careers', ats: { type: 'mynexthire', token: 'yulu' } },
  { name: 'YuppTV',                        country: 'India', site: 'yupptv.com',               careers: 'https://www.yupptv.com/careers' },
  { name: 'Yudiz Solutions',               country: 'India', site: 'yudiz.com',                careers: 'https://www.yudiz.com/join-our-team/' },
  { name: 'Yugasa Software Labs',          country: 'India', site: 'yugasa.com',               careers: 'https://yugasa.com/careers/' },
  { name: 'Yellow Class',                  country: 'India', site: 'yellowclass.com',          careers: 'https://www.yellowclass.com/careers' },
  { name: 'Yalamanchili Software Exports', country: 'India', site: 'yalamanchili.com',         careers: 'https://www.yalamanchili.com/careers' },
  { name: 'Yodlee (Envestnet)',            country: 'India', site: 'yodlee.com',               careers: 'https://www.envestnet.com/careers' },
  { name: 'YourStory Media',               country: 'India', site: 'yourstory.com',            careers: 'https://yourstory.com/careers' },
  { name: 'YES Securities',                country: 'India', site: 'yesinvest.in',             careers: 'https://www.yesinvest.in/careers', ats: { type: 'darwinbox', token: 'ysl' } },
  { name: 'Yash Highvoltage',              country: 'India', site: 'yashhighvoltage.com',      careers: 'https://www.yashhighvoltage.com/careers/' },
  { name: 'YOLO Bus',                      country: 'India', site: 'yolobus.in',               careers: 'https://www.yolobus.in/careers' },
  { name: 'Yes Madam',                     country: 'India', site: 'yesmadam.com',             careers: 'https://www.yesmadam.com/careers' },
  { name: 'Yaskawa India',                 country: 'India', site: 'yaskawaindia.in',          careers: 'https://www.yaskawaindia.in/careers' },
  { name: 'Yara India',                    country: 'India', site: 'yara.com',                 careers: 'https://www.yara.com/careers-at-yara/' },
  { name: 'YouGov India',                  country: 'India', site: 'yougov.co.in',             careers: 'https://jobs.yougov.com/' },
  { name: 'Ymgrad',                        country: 'India', site: 'ymgrad.com',               careers: 'https://ymgrad.com/careers' },
  { name: 'Yuvasoft Solutions',            country: 'India', site: 'yuvasoft.com',             careers: 'https://www.yuvasoft.com/career' },
  { name: 'Yash Raj Films',                country: 'India', site: 'yashrajfilms.com',         careers: 'https://www.yashrajfilms.com/careers' },
  { name: 'Yatharth Hospitals',            country: 'India', site: 'yatharthhospitals.com',    careers: 'https://yatharthhospitals.com/careers/' },
  { name: 'Ysquare Technology',            country: 'India', site: 'ysquaretechnology.com',      careers: 'https://ysquaretechnology.com/careers/' },
  { name: 'Yellow Slice',                  country: 'India', site: 'yellowslice.in',           careers: 'https://www.yellowslice.in/career' },
  { name: 'Yavar TechWorks',               country: 'India', site: 'yavar.in',                 careers: 'https://yavar.in/careers/' },
  { name: 'Yodaplus Technologies',         country: 'India', site: 'yodaplus.com',             careers: 'https://yodaplus.com/careers.html' },
  { name: 'YuktaMedia',                    country: 'India', site: 'yuktamedia.com',           careers: 'https://www.yuktamedia.com/careers/' },
  { name: 'Yagna iQ',                      country: 'India', site: 'yagnaiq.com',              careers: 'https://www.yagnaiq.com/company/careers/' },
  { name: 'YNOS Venture Engine',           country: 'India', site: 'ynos.in',                  careers: 'https://ynos.in/careers/' },
  { name: 'Yuken India',                   country: 'India', site: 'yukenindia.com',           careers: 'https://www.yukenindia.com/careers' },
  { name: 'Yasho Industries',              country: 'India', site: 'yashoindustries.com',      careers: 'https://www.yashoindustries.com/careers/' },
  { name: 'Yash Pakka',                    country: 'India', site: 'yashpakka.com',            careers: 'https://yashpakka.com/careers/' },
  { name: 'Ybrant Digital',                country: 'India', site: 'ybrantdigital.com',        careers: 'https://www.ybrantdigital.com/careers' },
  { name: 'Yumlane',                       country: 'India', site: 'yumlane.com',              careers: 'https://yumlane.com/careers' },
  { name: 'Yaap Digital',                  country: 'India', site: 'yaap.com',                 careers: 'https://yaap.com/careers/' },

  // ---------------------------------------------------------------- US / GLOBAL (39-100)
  { name: 'Yahoo',                         country: 'USA',   site: 'yahooinc.com',       careers: 'https://www.yahooinc.com/careers/', ats: { type: 'workday', token: 'ouryahoo', wd: 'wd5', site: 'careers' } },
  { name: 'Yelp',                          country: 'USA',   site: 'yelp.com',           careers: 'https://www.yelp.com/careers', ats: { type: 'phenom', host: 'https://www.yelp.careers' } },
  { name: 'Yext',                          country: 'USA',   site: 'yext.com',           careers: 'https://www.yext.com/careers', ats: { type: 'greenhouse', token: 'yext' } },
  { name: 'Yotpo',                         country: 'Israel',site: 'yotpo.com',          careers: 'https://www.yotpo.com/careers/', ats: { type: 'greenhouse', token: 'yotpo' } },
  { name: 'Yubico',                        country: 'Sweden',site: 'yubico.com',         careers: 'https://www.yubico.com/careers/', ats: { type: 'greenhouse', token: 'yubico' } },
  { name: 'YugabyteDB',                    country: 'USA',   site: 'yugabyte.com',       careers: 'https://www.yugabyte.com/careers/', ats: { type: 'greenhouse', token: 'yugabyte' } },
  { name: 'Yellowbrick Data',              country: 'USA',   site: 'yellowbrick.com',    careers: 'https://yellowbrick.com/careers/', ats: { type: 'greenhouse', token: 'yellowbrickdata' } },
  { name: 'Yardi Systems',                 country: 'USA',   site: 'yardi.com',          careers: 'https://www.yardi.com/careers/' },
  { name: 'YipitData',                     country: 'USA',   site: 'yipitdata.com',      careers: 'https://www.yipitdata.com/careers', ats: { type: 'greenhouse', token: 'yipitdata' } },
  { name: 'YCharts',                       country: 'USA',   site: 'ycharts.com',        careers: 'https://recruiting.paylocity.com/recruiting/jobs/All/78419728-0f20-46ce-8f93-12ae28d0f8c5/YCharts', ats: { type: 'paylocity', token: '78419728-0f20-46ce-8f93-12ae28d0f8c5' } },
  { name: 'Yieldmo',                       country: 'USA',   site: 'yieldmo.com',        careers: 'https://yieldmo.com/careers/', ats: { type: 'greenhouse', token: 'yieldmo' } },
  { name: 'Yieldstreet',                   country: 'USA',   site: 'yieldstreet.com',    careers: 'https://www.yieldstreet.com/careers/' },
  { name: 'Ylopo',                         country: 'USA',   site: 'ylopo.com',          careers: 'https://www.ylopo.com/careers', ats: { type: 'greenhouse', token: 'ylopo' } },
  { name: 'Yembo',                         country: 'USA',   site: 'yembo.ai',           careers: 'https://www.yembo.ai/careers', ats: { type: 'rippling', token: 'yembo' } },
  { name: 'Yendo',                         country: 'USA',   site: 'yendo.com',          careers: 'https://www.yendo.com/careers', ats: { type: 'ashby', token: 'yendo' } },
  { name: 'Yellow Systems',                country: 'USA',   site: 'yellow.systems',     careers: 'https://yellow.systems/careers' },
  { name: 'Yoodli',                        country: 'USA',   site: 'yoodli.ai',          careers: 'https://yoodli.ai/careers', ats: { type: 'greenhouse', token: 'yoodliinc' } },
  { name: 'Yotascale',                     country: 'USA',   site: 'yotascale.com',      careers: 'https://www.yotascale.com/careers' },
  { name: 'Yuvo Health',                   country: 'USA',   site: 'yuvohealth.com',     careers: 'https://www.yuvohealth.com/careers', ats: { type: 'greenhouse', token: 'yuvohealthllc' } },
  { name: 'Ytel',                          country: 'USA',   site: 'ytel.com',           careers: 'https://www.ytel.com/careers/' },
  { name: 'Yes Energy',                    country: 'USA',   site: 'yesenergy.com',      careers: 'https://www.yesenergy.com/careers', ats: { type: 'greenhouse', token: 'yesenergy' } },
  { name: 'Y Combinator',                  country: 'USA',   site: 'ycombinator.com',    careers: 'https://www.ycombinator.com/careers', ats: { type: 'ashby', token: 'ycombinator' } },
  { name: 'Yum! Brands',                   country: 'USA',   site: 'yum.com',            careers: 'https://jobs.yum.com/' },
  { name: 'Yum China',                     country: 'China', site: 'yumchina.com',       careers: 'https://www.yumchina.com/en/careers' },
  { name: 'Ygrene Energy Fund',            country: 'USA',   site: 'ygrene.com',         careers: 'https://ygrene.com/careers/' },
  { name: 'Yokogawa Electric',             country: 'Japan', site: 'yokogawa.com',       careers: 'https://www.yokogawa.com/careers/' },
  { name: 'Yamaha Motor',                  country: 'Japan', site: 'yamaha-motor.com',   careers: 'https://global.yamaha-motor.com/careers/', ats: { type: 'smartrecruiters', token: 'YamahaMotor' } },
  { name: 'Yaskawa Electric',              country: 'Japan', site: 'yaskawa-global.com', careers: 'https://www.yaskawa-global.com/careers' },
  { name: 'Yanmar',                        country: 'Japan', site: 'yanmar.com',         careers: 'https://www.yanmar.com/global/careers/' },
  { name: 'Yokohama TWS',                  country: 'Italy', site: 'yokohama-tws.com',   careers: 'https://www.yokohama-tws.com/careers/' },
  { name: 'Yara International',            country: 'Norway',site: 'yara.com',           careers: 'https://www.yara.com/careers-at-yara/vacancies/', ats: { type: 'smartrecruiters', token: 'YaraInternational' } },
  { name: 'YouGov',                        country: 'UK',    site: 'yougov.com',         careers: 'https://jobs.yougov.com/' },
  { name: 'Yolo Group',                    country: 'Estonia', site: 'yolo.com',         careers: 'https://yolo.com/careers/' },
  { name: 'Yoti',                          country: 'UK',    site: 'yoti.com',           careers: 'https://www.yoti.com/careers/' },
  { name: 'YuLife',                        country: 'UK',    site: 'yulife.com',         careers: 'https://yulife.com/careers/', ats: { type: 'teamtailor', host: 'https://careers.yulife.com' } },
  { name: 'Yordex',                        country: 'UK',    site: 'yordex.com',         careers: 'https://www.yordex.com/careers' },
  { name: 'Yoyo Wallet',                   country: 'UK',    site: 'yoyowallet.com',     careers: 'https://www.yoyowallet.com/careers' },
  { name: 'Yourgene Health',               country: 'UK',    site: 'yourgene-health.com',careers: 'https://yourgene-health.com/careers' },
  { name: 'Younited',                      country: 'France',site: 'younited.com',       careers: 'https://www.younited.com/careers', ats: { type: 'lever', token: 'younited' } },
  { name: 'Yousign',                       country: 'France',site: 'yousign.com',        careers: 'https://yousign.com/careers' },
  { name: 'Yves Rocher',                   country: 'France',site: 'yves-rocher.com',    careers: 'https://www.groupe-rocher.com/en/careers' },
  { name: 'Yubo',                          country: 'France',site: 'yubo.live',          careers: 'https://www.yubo.live/careers', ats: { type: 'ashby', token: 'yubo' } },
  { name: 'Yokoy',                         country: 'Switzerland', site: 'yokoy.com',    careers: 'https://yokoy.com/careers/' },
  { name: 'Ypsomed',                       country: 'Switzerland', site: 'ypsomed.com',  careers: 'https://www.ypsomed.com/en/career.html' },
  { name: 'Yousician',                     country: 'Finland', site: 'yousician.com',    careers: 'https://yousician.com/careers', ats: { type: 'greenhouse', token: 'yousician' } },
  { name: 'Younium',                       country: 'Sweden',site: 'younium.com',        careers: 'https://www.younium.com/careers', ats: { type: 'teamtailor', host: 'https://careers.younium.com' } },
  { name: 'Yodeck',                        country: 'Greece',site: 'yodeck.com',         careers: 'https://www.yodeck.com/careers/', ats: { type: 'workable', token: 'yodeck' } },
  { name: 'Yopeso',                        country: 'Romania', site: 'yopeso.com',       careers: 'https://www.yopeso.com/careers', ats: { type: 'recruitee', token: 'yopeso' } },
  { name: 'Yuki',                          country: 'Netherlands', site: 'yuki.nl',      careers: 'https://jobs.yukisoftware.com/', ats: { type: 'teamtailor', host: 'https://jobs.yukisoftware.com' } },
  { name: 'Yuno',                          country: 'Colombia', site: 'y.uno',           careers: 'https://www.y.uno/careers', ats: { type: 'lever', token: 'yuno' } },
  { name: 'Yassir',                        country: 'Algeria', site: 'yassir.com',       careers: 'https://yassir.com/careers' },
  { name: 'Yoco',                          country: 'South Africa', site: 'yoco.com',    careers: 'https://www.yoco.com/za/careers/' },
  { name: 'Yellow Card',                   country: 'Nigeria', site: 'yellowcard.io',    careers: 'https://yellowcard.io/careers/', ats: { type: 'bamboohr', token: 'yellowcard' } },
  { name: 'Youverify',                     country: 'Nigeria', site: 'youverify.co',     careers: 'https://youverify.co/careers' },
  { name: 'Yalla Group',                   country: 'UAE',   site: 'yalla.live',         careers: 'https://ir.yalla.live/careers' },
  { name: 'Yellowfin BI',                  country: 'Australia', site: 'yellowfinbi.com',careers: 'https://www.yellowfinbi.com/careers', ats: { type: 'jazzhr', token: 'idera' } },
  { name: 'Yodo1',                         country: 'Singapore', site: 'yodo1.com',      careers: 'https://www.yodo1.com/careers', ats: { type: 'teamtailor', host: 'https://careers.yodo1.com' } },
  { name: 'Yggdrasil Gaming',              country: 'Malta', site: 'yggdrasilgaming.com',careers: 'https://www.yggdrasilgaming.com/careers/', ats: { type: 'smartrecruiters', token: 'YggdrasilSandbox' } },
  { name: 'Yandex',                        country: 'Global',site: 'yandex.com',         careers: 'https://yandex.com/jobs/' },
  { name: 'Yellow Pages Canada',           country: 'Canada',site: 'yp.ca',              careers: 'https://corporate.yp.ca/yellow-pages-careers' },
  { name: 'Yuhu',                          country: 'Canada',site: 'yuhu.io',            careers: 'https://yuhu.io/careers/' },
  { name: 'Ynvisible Interactive',         country: 'Portugal', site: 'ynvisible.com',   careers: 'https://www.ynvisible.com/careers' },
];
