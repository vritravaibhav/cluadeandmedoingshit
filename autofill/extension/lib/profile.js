/* =============================================================================
 * autofill/extension/lib/profile.js
 * -----------------------------------------------------------------------------
 * The single source of truth for "who the user is".
 *
 * Every other module (match.js, fill.js, the AI bridge) reads from the object
 * exported here as AF.DEFAULT_PROFILE. Nothing in this file does any work --
 * it is pure data plus a large dictionary of label synonyms ("aliases").
 *
 * HOW THIS FILE IS LOADED
 *   This is a plain classic script. There is no build step, no npm, no
 *   'import' / 'export'. Chrome loads it in the order listed in manifest.json.
 *   Because content scripts run with "all_frames": true this file may be
 *   evaluated many times on one page, so the namespace is created defensively:
 *   we only create AF if somebody else has not created it already.
 *
 * ANALOGY FOR A SPRING DEVELOPER
 *   Think of AF.DEFAULT_PROFILE as an @ConfigurationProperties bean holding
 *   application.yml values, and AF.DEFAULT_PROFILE.aliases as the mapping
 *   layer (like a @JsonAlias set) that tells the matcher which incoming
 *   form-label strings map onto which property path.
 * ========================================================================== */

// Defensive namespace creation. Read this as:
//   "AF = the existing globalThis.AF if there is one, otherwise a new {}".
// The inner assignment also writes it back onto globalThis so later files see it.
var AF = (globalThis.AF = globalThis.AF || {});

/* -----------------------------------------------------------------------------
 * PROFILE_VERSION
 * -----------------------------------------------------------------------------
 * Bump this integer whenever the SHAPE of DEFAULT_PROFILE changes (a key is
 * renamed, removed, or nested differently). Storage-migration code can compare
 * the version saved in chrome.storage against this number and decide whether a
 * saved profile needs upgrading before it is used.
 * -------------------------------------------------------------------------- */
AF.PROFILE_VERSION = 1;

/* =============================================================================
 * AF.DEFAULT_PROFILE
 * =============================================================================
 * Facts in the 'personal', 'links', 'education', 'experience', 'projects' and
 * 'skills' sections are copied verbatim from the user's resume. Do not edit
 * them to make a particular application look better -- lying on an application
 * is the user's decision, not the extension's.
 *
 * Sections below the resume data (workAuthorization, noticePeriod, EEO, ...)
 * are "application-only" answers. Job forms ask for them constantly but a
 * resume never carries them, so they are configured here once.
 * ========================================================================== */
AF.DEFAULT_PROFILE = {

  /* ---------------------------------------------------------------------------
   * 1. PERSONAL
   * -------------------------------------------------------------------------
   * phone is stored WITHOUT the country code, and phoneCountryCode holds the
   * '+91' separately. Many forms (Workday, Greenhouse) split these into two
   * inputs; the ones that want a single field can be handed
   * phoneCountryCode + phone concatenated by the filler.
   * ------------------------------------------------------------------------ */
  personal: {
    fullName:         'Divyanshu Vaibhav',
    firstName:        'Divyanshu',
    lastName:         'Vaibhav',
    email:            'divaibhavyanshu@gmail.com',
    phone:            '9576671336',
    phoneCountryCode: '+91',

    // NOTE: the resume does not state a home address anywhere. The only two
    // places it mentions are an employer office (Dubai) and a university
    // (Panjab University). Inventing a residence would put false information
    // into real applications, so city and state are deliberately left blank
    // for the user to fill in once. See the REVIEW BLOCK at the bottom.
    city:    '',
    state:   '',
    country: 'India'   // consistent with workAuthorization: 'Indian citizen'
  },

  /* ---------------------------------------------------------------------------
   * 2. LINKS
   * -------------------------------------------------------------------------
   * The resume prints bare domains (github.com/vritravaibhav). Application
   * forms almost always validate these as URLs, so full https:// forms are
   * stored here and the bare text is kept only in the aliases comments.
   * ------------------------------------------------------------------------ */
  links: {
    linkedin:  'https://www.linkedin.com/in/divyanshu-vaibhav',
    github:    'https://github.com/vritravaibhav',
    portfolio: 'https://vritravaibhav.github.io/portfolio'
  },

  /* ---------------------------------------------------------------------------
   * 3. EDUCATION
   * -------------------------------------------------------------------------
   * Resume line: "B.E. Electronics & Communication - Panjab University -
   * 2020-2024". Years are numbers, not strings, because some forms want to do
   * arithmetic / range validation on them.
   * ------------------------------------------------------------------------ */
  education: {
    degree:         'B.E.',
    field:          'Electronics & Communication',
    institution:    'Panjab University',
    startYear:      2020,
    graduationYear: 2024
  },

  /* ---------------------------------------------------------------------------
   * 4. EXPERIENCE
   * -------------------------------------------------------------------------
   * Ordered most-recent first, which is the order every application form
   * expects when it asks you to add employment history row by row.
   *
   * Date format is 'MMM YYYY' (the resume's own format). endDate is '' when
   * current is true. Bullets are copied faithfully -- same numbers, same
   * claims -- because these are the sentences the AI bridge will paraphrase
   * for long-form answers, and it must not drift from the truth.
   * ------------------------------------------------------------------------ */
  experience: [
    {
      company:   'Longfloat Information Technology Pvt. Ltd.',
      title:     'Software Engineer',
      location:  'Dubai',
      startDate: 'Jan 2026',
      endDate:   '',
      current:   true,
      bullets: [
        'Designed and developed Spring Boot REST microservices (Spring Data JPA, Hibernate, Flyway migrations) powering AI features and core backend APIs consumed by Flutter clients.',
        'Implemented stateless JWT authentication and role-based access control with Spring Security, plus centralized exception handling, DTO mapping, and request validation (Bean Validation).',
        'Wrote unit and integration tests with JUnit 5 and Mockito; documented endpoints with Swagger/OpenAPI and containerized services with Docker for consistent environments.',
        'Architected hardware-accelerated rendering pipelines on Android Native (NDK/JNI), cutting UI frame-drop rate by 40%; built C++/JNI bridges exposing hardware APIs to Flutter.',
        'Resolved critical memory leaks and race conditions in production Flutter apps, reducing crash rates by 35%.'
      ]
    },
    {
      company:   'Electromotion E-vidyut',
      title:     'Software Developer',
      location:  '',   // resume does not state a location for this employer
      startDate: 'Sep 2024',
      endDate:   'Jan 2026',
      current:   false,
      bullets: [
        'Designed Spring Boot backend services for a production ride-hailing platform - trip lifecycle, fare calculation, and driver-rider matching - with layered architecture (Controller-Service-Repository).',
        'Optimized JPA/MySQL indexing and query design for low-latency geo queries; profiled and eliminated N+1 query patterns to keep matching latency low under load.',
        'Built a Google Maps routing engine and server-side tile-caching layer, reducing map API costs by 85% and total infrastructure spend by over 6x.',
        'Developed 7+ native plugins (Android/iOS) for battery, overlay display, and geolocation to support the apps.',
        'Led a 5-member team delivering 9+ production Flutter apps, including the Aamcha Chalak captain app and Aamcha Auto rider app (Uber/Rapido-style).',
        'Improved crash-free rate from 67% to 94% via Firebase Crashlytics; shipped A/B Testing, Remote Config, and FCM campaigns to decouple releases from launches.'
      ]
    },
    {
      company:   'Connect 4 Digital India',
      title:     'Flutter Developer',
      location:  '',   // resume does not state a location for this employer
      startDate: 'Mar 2024',
      endDate:   'Aug 2024',
      current:   false,
      bullets: [
        'Integrated WebRTC P2P audio/video (ICE/STUN/TURN, WebSocket signaling), 130+ WooCommerce REST APIs, and Stripe SDK payments within Flutter apps; managed state with BLoC.'
      ]
    }
  ],

  /* ---------------------------------------------------------------------------
   * 5. PROJECTS
   * -------------------------------------------------------------------------
   * 'tagline' is the one-line pitch (useful for forms with a short "describe
   * your project" box). 'stack' is the technology list split into an array so
   * the matcher can join it with whatever separator a form prefers.
   * ------------------------------------------------------------------------ */
  projects: [
    {
      name:    'SalesPilot',
      tagline: 'AI-Powered Sales Outreach Suite - Spring Boot backend + Flutter client with multi-agent AI email authoring, contact capture, and multi-product campaign pipelines.',
      stack: [
        'Spring Boot',
        'Spring Data JPA',
        'MySQL',
        'Flutter',
        'WebView',
        'LLM APIs',
        'Gmail/SMTP',
        'Firebase'
      ],
      bullets: [
        'Built the Spring Boot backend - REST APIs for contacts, templates, campaigns, and send-tracking history - with Spring Data JPA persistence and Gmail/SMTP integration for one-click outreach.',
        'Orchestrated multiple AI agents (LLM APIs) to create and edit HTML email templates - one agent drafts copy, another refines layout - with live preview before send.',
        'Developed a lightweight CRM layer to maintain client data - an embedded in-app browser auto-captures email IDs from visited pages, organized into contact profiles with interaction history, deal stage, and follow-up status (Spring Data JPA, per-product segmentation).',
        'Added an AI sales advisor that analyzes campaign performance and client engagement (opens, replies, stage drop-offs) and recommends next actions to increase sales - who to follow up with, when, and with which template.'
      ]
    },
    {
      name:    'DroopIt',
      tagline: 'P2P Collaboration Platform (Chrome Extension + App) - team workspace where friends chat, share files P2P, and an AI project manager assigns tasks and follows up on progress.',
      stack: [
        'Flutter (App + Wasm Extension)',
        'Spring Boot',
        'WebSocket/STOMP',
        'Spring Scheduler',
        'MySQL',
        'WebRTC',
        'LLM APIs',
        'FCM'
      ],
      bullets: [
        'Built real-time group chat with a Spring Boot WebSocket (STOMP) backend - message persistence via Spring Data JPA, delivery/read receipts, and multi-room support for project teams.',
        'Implemented an AI project manager: breaks a project goal into tasks, assigns tasks to team members based on workload, and proactively follows up for progress updates via scheduled jobs (Spring Scheduler) and FCM notifications.',
        'Engineered serverless P2P file transfer over WebRTC data channels (Chrome Extension, Flutter Wasm) - chunked streaming writes supporting files up to 1 TB, checkpoint-based resume, SHA-256 chunk verification.'
      ]
    }
  ],

  /* ---------------------------------------------------------------------------
   * 6. SKILLS
   * -------------------------------------------------------------------------
   * Two views of the same data:
   *   skills            -> one flat array, easy to search / join / dump into a
   *                        "list your skills" textarea.
   *   skillsByCategory  -> grouped exactly as the resume groups them, for forms
   *                        that ask category by category.
   * ------------------------------------------------------------------------ */
  skills: [
    // Backend
    'Java',
    'Spring Boot',
    'Spring Security (JWT)',
    'Spring Data JPA',
    'Hibernate',
    'Spring MVC',
    'RESTful APIs',
    'Microservices',
    'RabbitMQ',
    'Flyway',
    'Maven',
    // Databases & Caching
    'MySQL',
    'MongoDB',
    'Redis (caching, geo queries)',
    'Query optimization & indexing',
    'Firebase (Firestore, RTDB)',
    // Testing & DevOps
    'JUnit 5',
    'Mockito',
    'Swagger/OpenAPI',
    'Docker',
    'Postman',
    'Git',
    'GitHub Actions (CI/CD)',
    // Mobile & Frontend
    'Flutter',
    'Dart',
    'BLoC',
    'Riverpod',
    'Provider',
    'Android Native (NDK/JNI, C++)',
    'WebRTC',
    // Other
    'Stripe SDK',
    'FCM',
    'Crashlytics',
    'A/B Testing',
    'Remote Config',
    'AI Agents (LLM APIs)',
    'Figma',
    // Problem Solving
    'Data Structures & Algorithms (400+ problems on LeetCode and Codeforces, Java / Dart)'
  ],

  // Keys here are the resume's own category headings, kept verbatim so the
  // popup UI can render the same sections the user already recognises.
  skillsByCategory: {
    'Backend': [
      'Java',
      'Spring Boot',
      'Spring Security (JWT)',
      'Spring Data JPA',
      'Hibernate',
      'Spring MVC',
      'RESTful APIs',
      'Microservices',
      'RabbitMQ',
      'Flyway',
      'Maven'
    ],
    'Databases & Caching': [
      'MySQL',
      'MongoDB',
      'Redis (caching, geo queries)',
      'Query optimization & indexing',
      'Firebase (Firestore, RTDB)'
    ],
    'Testing & DevOps': [
      'JUnit 5',
      'Mockito',
      'Swagger/OpenAPI',
      'Docker',
      'Postman',
      'Git',
      'GitHub Actions (CI/CD)'
    ],
    'Mobile & Frontend': [
      'Flutter',
      'Dart',
      'BLoC',
      'Riverpod',
      'Provider',
      'Android Native (NDK/JNI, C++)',
      'WebRTC'
    ],
    'Other': [
      'Stripe SDK',
      'FCM',
      'Crashlytics',
      'A/B Testing',
      'Remote Config',
      'AI Agents (LLM APIs)',
      'Figma'
    ],
    'Problem Solving': [
      'Solved 400+ DSA problems on LeetCode and Codeforces (Java / Dart)'
    ]
  },

  /* ---------------------------------------------------------------------------
   * 7. YEARS OF EXPERIENCE
   * -------------------------------------------------------------------------
   * Computed from the resume, NOT guessed:
   *   first professional role  = Mar 2024 (Connect 4 Digital India)
   *   profile authored         = Aug 2026
   *   elapsed                  = ~2 years 5 months  -> 2 (integer, rounded down)
   *
   * Rounding DOWN is deliberate: forms with a "minimum years" dropdown should
   * never be given a number the user cannot defend in an interview.
   *
   * IMPORTANT: this is a static integer, not a live calculation. Re-check it
   * roughly every six months. See the REVIEW BLOCK at the bottom of the file.
   * ------------------------------------------------------------------------ */
  yearsOfExperience: 2,

  // Per-skill totals, each derived from the first role in which the skill
  // actually appears on the resume. Same round-down rule.
  yearsBySkill: {
    'Java':          2,   // since Sep 2024 (Electromotion Spring Boot services)
    'Spring Boot':   2,   // since Sep 2024
    'Flutter':       2,   // since Mar 2024 (Connect 4 Digital India)
    'Dart':          2,   // since Mar 2024
    'Android':       2,   // since Mar 2024, native plugins + NDK/JNI later
    'MySQL':         2,   // since Sep 2024 (JPA/MySQL indexing work)
    'Docker':        1,   // since Jan 2026 (Longfloat containerisation)
    'REST APIs':     2,   // since Mar 2024 (130+ WooCommerce REST APIs)
    'Microservices': 1    // since Jan 2026 (Longfloat Spring Boot microservices)
  },

  /* ---------------------------------------------------------------------------
   * 8. APPLICATION-ONLY ANSWERS
   * -------------------------------------------------------------------------
   * None of this appears on a resume, but nearly every ATS asks for it.
   * ------------------------------------------------------------------------ */

  // Work authorisation / immigration ----------------------------------------
  workAuthorization:   'Indian citizen',
  requiresSponsorship: false,
  visaStatus:          'Not applicable - Indian citizen',

  // Availability -------------------------------------------------------------
  noticePeriod:      '30 days',
  earliestStartDate: 'Within 30 days',

  // Compensation -------------------------------------------------------------
  // Left blank ON PURPOSE. Salary is the one answer that should never be
  // auto-filled from a stale default -- the user types it per application.
  // The matcher is expected to treat '' as "skip this field, do not guess".
  currentCTC:     '',
  expectedCTC:    '',
  salaryCurrency: 'INR',

  // Location preferences -----------------------------------------------------
  willingToRelocate: true,
  preferredLocations: [
    'Remote',
    'Bangalore',
    'Hyderabad',
    'Pune',
    'Dubai'
  ],

  // Equal-employment-opportunity (EEO) / demographic questions ---------------
  // Blank by design. These are voluntary self-identification questions in the
  // US and the extension must not answer them on the user's behalf. Leaving
  // them '' means the filler skips the field and the user opts in manually.
  gender:           '',
  ethnicity:        '',
  veteranStatus:    '',
  disabilityStatus: '',

  // Sourcing questions -------------------------------------------------------
  howDidYouHear: 'Company website',
  referredBy:    '',

  /* ---------------------------------------------------------------------------
   * 9. COVER LETTERS
   * -------------------------------------------------------------------------
   * Three genuinely different paragraphs for the three kinds of role the user
   * applies to. Every claim below is traceable to a resume bullet.
   *
   * Substitution tokens -- the filler replaces these two strings and nothing
   * else:
   *   {{COMPANY}}  ->  the hiring company's name
   *   {{ROLE}}     ->  the job title being applied for
   *
   * There are no other placeholders. If the filler cannot resolve a token it
   * should leave the letter out entirely rather than send raw braces.
   * ------------------------------------------------------------------------ */
  coverLetters: {

    // ~120 words. Server-side framing: JPA/MySQL tuning, cost engineering,
    // Spring Security, testing discipline.
    backend: 'I am applying for the {{ROLE}} position at {{COMPANY}}. I build Spring Boot services for production systems: REST microservices with Spring Data JPA, Hibernate and Flyway migrations, stateless JWT authentication and role-based access control through Spring Security, and centralized exception handling with Bean Validation on every request. On a ride-hailing platform I tuned JPA and MySQL indexing for low-latency geo queries and eliminated N+1 query patterns so driver-rider matching stayed fast under load, then built a routing engine with a server-side tile-caching layer that cut map API costs by 85% and total infrastructure spend more than sixfold. I test what I ship with JUnit 5 and Mockito, document endpoints with Swagger, and containerize with Docker. I would like to bring that same cost-aware engineering to {{COMPANY}}.',

    // ~120 words. Mobile framing: crash-free rate, frame drops, NDK/JNI,
    // release engineering, team lead.
    mobile: 'I am writing about the {{ROLE}} role at {{COMPANY}}. I have shipped 9+ production Flutter applications, including a captain app and a rider app in the Uber and Rapido mould, and I led the five-person team that delivered them. Stability is the part of mobile work I care most about: I raised one product line from a 67% crash-free rate to 94% using Firebase Crashlytics, and separately cut crash rates by 35% by hunting down memory leaks and race conditions in live apps. On the performance side I architected hardware-accelerated rendering on Android Native through NDK and JNI, reducing UI frame drops by 40%, and wrote 7+ native plugins for battery, overlay and geolocation. I would enjoy doing this work at {{COMPANY}}.',

    // ~120 words. Full-stack framing: owning both halves, personal projects,
    // the Spring-plus-Flutter seam.
    fullstack: 'I am interested in the {{ROLE}} opening at {{COMPANY}} because I work on both halves of the product rather than one. Professionally I write Spring Boot REST APIs with Spring Data JPA and Spring Security, and I consume them from the Flutter clients I build, so I design the contract between the two instead of inheriting it. I also write C++ and JNI bridges exposing hardware APIs into Flutter. On my own time I built SalesPilot, a Spring Boot and Flutter outreach suite where multiple AI agents draft and refine email campaigns, and DroopIt, a collaboration platform with a WebSocket STOMP backend and WebRTC peer-to-peer file transfer that streams files up to 1 TB with resumable, SHA-256 verified chunks. I would like to build end to end at {{COMPANY}}.'
  },

  /* ===========================================================================
   * 10. ALIASES  --  the heart of the deterministic matcher
   * ===========================================================================
   * SHAPE:  { 'dot.notation.path.into.this.profile': [ 'label', 'label', ... ] }
   *
   * The left-hand key is a path into AF.DEFAULT_PROFILE (the matcher walks it
   * with a simple split('.') loop). The right-hand array is every label string
   * a real application form might use for that value.
   *
   * RULES FOR ENTRIES -- follow these when adding your own:
   *   1. ALWAYS lowercase. The matcher lowercases the scraped label before
   *      comparing, so an uppercase alias here can never match anything.
   *   2. No trailing punctuation, no asterisks, no colons. The matcher is
   *      expected to strip '*', ':' and surrounding whitespace from the page
   *      label first. Writing 'first name' (not 'First Name *') keeps this
   *      table comparable.
   *   3. Include abbreviations AND expansions ('ctc' and 'cost to company').
   *   4. Include BOTH Indian and US/Western phrasings. Indian portals say
   *      "current ctc", "notice period", "lakhs"; US portals say "current
   *      compensation", "when can you start", "salary expectations".
   *   5. Order does not matter, but longer / more specific strings are safer
   *      to add because a good matcher prefers the longest alias that fits.
   *
   * WHY SO MANY: every alias that hits here is a field the AI bridge does NOT
   * have to be called for. Aliases are free and instant; AI calls are slow,
   * cost money, and can be wrong. Prefer adding an alias over adding AI.
   * ======================================================================== */
  aliases: {

    /* ---- personal: name -------------------------------------------------- */
    'personal.fullName': [
      'full name',
      'name',
      'your name',
      'candidate name',
      'applicant name',
      'legal name',
      'full legal name',
      'name as per passport',
      'name (first and last)',
      'first and last name',
      'complete name',
      'display name',
      'contact name',
      'full name of applicant'
    ],

    'personal.firstName': [
      'first name',
      'firstname',
      'given name',
      'given names',
      'forename',
      'first',
      'legal first name',
      'preferred first name',
      'fname',
      'first name (as it appears on your id)',
      'candidate first name',
      'applicant first name'
    ],

    'personal.lastName': [
      'last name',
      'lastname',
      'surname',
      'family name',
      'last',
      'legal last name',
      'lname',
      'second name',
      'last name (as it appears on your id)',
      'candidate last name',
      'applicant last name'
    ],

    /* ---- personal: contact ----------------------------------------------- */
    'personal.email': [
      'email',
      'e-mail',
      'email address',
      'e-mail address',
      'email id',
      'email-id',
      'your email',
      'contact email',
      'personal email',
      'primary email',
      'work email',
      'login email',
      'email address (personal)',
      'confirm email',
      'confirm email address',
      're-enter email'
    ],

    'personal.phone': [
      'phone',
      'phone number',
      'telephone',
      'telephone number',
      'mobile',
      'mobile number',
      'mobile no',
      'cell',
      'cell phone',
      'cell phone number',
      'contact number',
      'contact no',
      'primary phone',
      'personal phone',
      'whatsapp number',
      'phone (mobile)',
      'number'
    ],

    'personal.phoneCountryCode': [
      'country code',
      'phone country code',
      'dialing code',
      'dialling code',
      'isd code',
      'std code',
      'phone code',
      'international code',
      'country calling code',
      'code',
      '+country code',
      'mobile country code'
    ],

    /* ---- personal: location ---------------------------------------------- */
    'personal.city': [
      'city',
      'town',
      'city of residence',
      'current city',
      'current location',
      'present city',
      'location',
      'where are you located',
      'where do you live',
      'city/town',
      'city, state',
      'home city',
      'base location',
      'your location'
    ],

    'personal.state': [
      'state',
      'province',
      'region',
      'state/province',
      'state or province',
      'state / union territory',
      'county',
      'territory',
      'current state',
      'state of residence',
      'administrative area'
    ],

    'personal.country': [
      'country',
      'country of residence',
      'current country',
      'nation',
      'country/region',
      'country or region',
      'residing country',
      'which country do you live in',
      'country you are based in',
      'home country'
    ],

    /* ---- links ------------------------------------------------------------ */
    'links.linkedin': [
      'linkedin',
      'linkedin url',
      'linkedin profile',
      'linkedin profile url',
      'linkedin link',
      'linked in',
      'linkedin.com',
      'linkedin handle',
      'linkedin id',
      'your linkedin',
      'linkedin (optional)',
      'social profile',
      'professional profile url'
    ],

    'links.github': [
      'github',
      'github url',
      'github profile',
      'github profile url',
      'github link',
      'git hub',
      'github.com',
      'github username',
      'github handle',
      'code repository',
      'repository link',
      'gitlab/github',
      'source code profile',
      'your github'
    ],

    'links.portfolio': [
      'portfolio',
      'portfolio url',
      'portfolio link',
      'website',
      'personal website',
      'personal site',
      'website url',
      'blog',
      'blog url',
      'personal blog',
      'online portfolio',
      'other website',
      'url',
      'homepage',
      'link to your work',
      'work samples'
    ],

    /* ---- education -------------------------------------------------------- */
    'education.degree': [
      'degree',
      'highest degree',
      'degree earned',
      'degree obtained',
      'qualification',
      'highest qualification',
      'education level',
      'level of education',
      'highest level of education',
      'academic degree',
      'degree type',
      'graduation degree',
      'ug degree'
    ],

    'education.field': [
      'field of study',
      'major',
      'discipline',
      'specialization',
      'specialisation',
      'branch',
      'stream',
      'course',
      'subject',
      'area of study',
      'degree major',
      'concentration',
      'field'
    ],

    'education.institution': [
      'school',
      'university',
      'college',
      'institution',
      'institute',
      'school name',
      'university name',
      'college name',
      'alma mater',
      'name of institution',
      'educational institution',
      'where did you study',
      'university/college'
    ],

    'education.graduationYear': [
      'graduation year',
      'year of graduation',
      'year of passing',
      'passing year',
      'passout year',
      'batch',
      'batch year',
      'graduation date',
      'end year',
      'completion year',
      'year completed',
      'expected graduation',
      'to year',
      'graduated in'
    ],

    'education.startYear': [
      'start year',
      'year started',
      'from year',
      'admission year',
      'year of admission',
      'enrollment year',
      'enrolment year',
      'education start date',
      'course start year',
      'joined in',
      'from'
    ],

    /* ---- experience -------------------------------------------------------
     * These point at index 0 of the experience array, i.e. the CURRENT job,
     * because that is what "current employer" style single-line questions
     * want. Multi-row employment history tables are handled by the filler
     * iterating the array, not by these aliases.
     * ---------------------------------------------------------------------- */
    'experience.0.company': [
      'current company',
      'current employer',
      'company',
      'employer',
      'company name',
      'present company',
      'present employer',
      'organization',
      'organisation',
      'current organization',
      'current organisation',
      'most recent employer',
      'latest company',
      'where do you currently work',
      'employer name'
    ],

    'experience.0.title': [
      'current title',
      'job title',
      'current job title',
      'current designation',
      'designation',
      'current role',
      'title',
      'position',
      'current position',
      'present designation',
      'most recent job title',
      'your role',
      'role',
      'occupation'
    ],

    /* ---- experience totals ------------------------------------------------ */
    'yearsOfExperience': [
      'years of experience',
      'total experience',
      'total years of experience',
      'work experience',
      'experience',
      'experience in years',
      'yrs of experience',
      'years experience',
      'how many years of experience do you have',
      'total work experience',
      'overall experience',
      'relevant experience',
      'years of relevant experience',
      'professional experience',
      'exp (years)',
      'total exp'
    ],

    'yearsBySkill.Java': [
      'years of java experience',
      'java experience',
      'years of experience with java',
      'how many years of java',
      'java (years)',
      'experience in java',
      'java years',
      'core java experience'
    ],

    'yearsBySkill.Spring Boot': [
      'years of spring boot experience',
      'spring boot experience',
      'years of experience with spring boot',
      'spring experience',
      'spring boot (years)',
      'experience in spring boot',
      'spring/spring boot experience',
      'spring boot years'
    ],

    'yearsBySkill.Flutter': [
      'years of flutter experience',
      'flutter experience',
      'years of experience with flutter',
      'flutter (years)',
      'experience in flutter',
      'flutter years',
      'how many years of flutter'
    ],

    'yearsBySkill.Dart': [
      'years of dart experience',
      'dart experience',
      'years of experience with dart',
      'dart (years)',
      'experience in dart',
      'dart years'
    ],

    'yearsBySkill.Android': [
      'years of android experience',
      'android experience',
      'years of experience with android',
      'android (years)',
      'experience in android',
      'android development experience',
      'native android experience',
      'android years'
    ],

    'yearsBySkill.MySQL': [
      'years of mysql experience',
      'mysql experience',
      'years of experience with mysql',
      'sql experience',
      'mysql (years)',
      'experience in mysql',
      'database experience',
      'rdbms experience'
    ],

    'yearsBySkill.Docker': [
      'years of docker experience',
      'docker experience',
      'years of experience with docker',
      'docker (years)',
      'experience in docker',
      'containerization experience',
      'containerisation experience',
      'docker years'
    ],

    'yearsBySkill.REST APIs': [
      'years of rest api experience',
      'rest api experience',
      'years of experience with rest apis',
      'api experience',
      'restful api experience',
      'experience building apis',
      'rest experience',
      'web services experience'
    ],

    'yearsBySkill.Microservices': [
      'years of microservices experience',
      'microservices experience',
      'years of experience with microservices',
      'microservice experience',
      'experience in microservices',
      'microservices architecture experience',
      'distributed systems experience'
    ],

    /* ---- skills ----------------------------------------------------------- */
    'skills': [
      'skills',
      'key skills',
      'technical skills',
      'core skills',
      'skill set',
      'skillset',
      'your skills',
      'primary skills',
      'relevant skills',
      'technologies',
      'tech stack',
      'stack',
      'tools and technologies',
      'programming languages',
      'areas of expertise',
      'competencies'
    ],

    /* ---- notice period / availability ------------------------------------- */
    'noticePeriod': [
      'notice period',
      'current notice period',
      'notice period (in days)',
      'notice period in days',
      'official notice period',
      'what is your notice period',
      'serving notice period',
      'notice',
      'how much notice do you need to give',
      'resignation notice period',
      'notice period (days)',
      'joining time',
      'time to join'
    ],

    'earliestStartDate': [
      'start date',
      'earliest start date',
      'available start date',
      'availability',
      'when can you start',
      'when can you join',
      'joining date',
      'date of joining',
      'earliest joining date',
      'available from',
      'how soon can you join',
      'preferred start date',
      'when are you available to start',
      'availability to start',
      'target start date',
      'earliest availability'
    ],

    /* ---- compensation -----------------------------------------------------
     * NOTE: currentCTC and expectedCTC are '' in this profile, so these
     * aliases exist mainly so the matcher can positively IDENTIFY the field
     * and mark it 'skip' (highlighted for the user) rather than let the AI
     * bridge invent a number.
     * ---------------------------------------------------------------------- */
    'currentCTC': [
      'current ctc',
      'ctc',
      'current salary',
      'present salary',
      'current compensation',
      'current annual salary',
      'current fixed ctc',
      'current ctc (in lpa)',
      'current ctc in lakhs',
      'current ctc (lakhs)',
      'annual ctc',
      'current package',
      'existing ctc',
      'current base salary',
      'what is your current ctc',
      'present ctc',
      'current remuneration'
    ],

    'expectedCTC': [
      'expected ctc',
      'expected salary',
      'expected compensation',
      'salary expectation',
      'salary expectations',
      'desired salary',
      'desired compensation',
      'expected package',
      'expected ctc (in lpa)',
      'expected ctc in lakhs',
      'expected ctc (lakhs)',
      'what are your salary expectations',
      'compensation expectations',
      'desired annual salary',
      'expected annual salary',
      'salary requirement',
      'salary requirements',
      'minimum expected salary',
      'expected remuneration',
      'rate',
      'hourly rate',
      'expected hourly rate'
    ],

    'salaryCurrency': [
      'currency',
      'salary currency',
      'preferred currency',
      'compensation currency',
      'currency of salary',
      'pay currency',
      'select currency',
      'currency type'
    ],

    /* ---- work authorisation ----------------------------------------------- */
    'workAuthorization': [
      'work authorization',
      'work authorisation',
      'are you legally authorized to work',
      'are you legally authorised to work',
      'are you authorized to work',
      'legally authorized to work in the united states',
      'right to work',
      'do you have the right to work',
      'employment eligibility',
      'authorized to work',
      'work eligibility',
      'work permit status',
      'citizenship',
      'citizenship status',
      'nationality',
      'are you eligible to work'
    ],

    'requiresSponsorship': [
      'do you require sponsorship',
      'will you now or in the future require sponsorship',
      'require visa sponsorship',
      'do you need sponsorship',
      'sponsorship required',
      'visa sponsorship',
      'will you require sponsorship for employment',
      'do you require employment visa sponsorship',
      'need sponsorship to work',
      'require h1b sponsorship',
      'sponsorship needed',
      'do you now or will you in the future require sponsorship'
    ],

    'visaStatus': [
      'visa status',
      'current visa status',
      'immigration status',
      'what is your visa status',
      'visa type',
      'work visa',
      'residency status',
      'do you hold a valid visa',
      'permit type',
      'legal status'
    ],

    /* ---- relocation & location preference ---------------------------------- */
    'willingToRelocate': [
      'willing to relocate',
      'are you willing to relocate',
      'open to relocation',
      'relocation',
      'would you relocate',
      'willing to move',
      'relocate',
      'are you open to relocating',
      'willing to relocate to the job location',
      'relocation willingness',
      'can you relocate',
      'ok with relocation'
    ],

    'preferredLocations': [
      'preferred location',
      'preferred locations',
      'preferred work location',
      'preferred job location',
      'location preference',
      'desired location',
      'where would you like to work',
      'preferred city',
      'work location preference',
      'locations you are open to',
      'preferred office location',
      'which locations are you interested in'
    ],

    /* ---- sourcing ---------------------------------------------------------- */
    'howDidYouHear': [
      'how did you hear about us',
      'how did you hear about this job',
      'how did you hear about this position',
      'how did you find us',
      'where did you hear about us',
      'source',
      'referral source',
      'how did you learn about this opportunity',
      'how did you find this job',
      'what brought you here',
      'how did you come to know about this role',
      'lead source'
    ],

    'referredBy': [
      'referred by',
      'referral',
      'referral name',
      'employee referral',
      'who referred you',
      'name of referrer',
      'referrer',
      'do you know anyone at the company',
      'reference name',
      'internal referral',
      'referred by (employee name)'
    ],

    /* ---- EEO / voluntary self-identification -------------------------------
     * All four profile values are '' so these aliases identify the field and
     * let fill.js highlight it 'skip'. The user answers these themselves.
     * ----------------------------------------------------------------------- */
    'gender': [
      'gender',
      'sex',
      'gender identity',
      'what is your gender',
      'please select your gender',
      'gender (voluntary)',
      'i identify my gender as',
      'voluntary self identification of gender'
    ],

    'ethnicity': [
      'ethnicity',
      'race',
      'race/ethnicity',
      'ethnic background',
      'ethnic group',
      'racial identity',
      'hispanic or latino',
      'what is your race or ethnicity',
      'ethnicity (voluntary)',
      'voluntary self identification of ethnicity'
    ],

    'veteranStatus': [
      'veteran status',
      'protected veteran status',
      'are you a veteran',
      'military service',
      'military status',
      'are you a protected veteran',
      'veteran',
      'us veteran status',
      'voluntary self identification of veteran status'
    ],

    'disabilityStatus': [
      'disability status',
      'do you have a disability',
      'disability',
      'voluntary self identification of disability',
      'are you disabled',
      'disability (voluntary)',
      'please check one of the boxes below disability',
      'do you identify as having a disability'
    ],

    /* ---- cover letter ------------------------------------------------------
     * Points at the full-stack letter as the safe default. match.js is free to
     * pick 'backend' or 'mobile' instead based on the job title it scraped --
     * this alias only guarantees the FIELD is recognised.
     * ----------------------------------------------------------------------- */
    'coverLetters.fullstack': [
      'cover letter',
      'covering letter',
      'why do you want to work here',
      'why are you interested in this role',
      'tell us about yourself',
      'why should we hire you',
      'motivation',
      'additional information',
      'anything else you would like us to know',
      'introduce yourself',
      'brief introduction',
      'summary',
      'professional summary',
      'proposal',
      'cover letter (optional)',
      'message to the hiring manager',
      'note to employer'
    ]
  }
};

/* =============================================================================
 * REVIEW BLOCK -- CHECK THESE BEFORE THE FIRST REAL APPLICATION
 * =============================================================================
 * Everything listed here is either intentionally blank or time-sensitive.
 * Nothing else in this file needs touching.
 *
 * MUST FILL IN (blank, and forms will ask):
 *   personal.city        -- the resume states no home address. Set this.
 *   personal.state       -- same. Set this.
 *   personal.country     -- currently 'India'. Change if you have relocated to
 *                           the UAE for the Longfloat role.
 *
 * FILL IN PER APPLICATION (deliberately blank, never auto-filled):
 *   currentCTC           -- your real current CTC.
 *   expectedCTC          -- your ask for THIS role. Do not set a global default.
 *   referredBy           -- only when you actually have a referral.
 *
 * OPT IN ONLY IF YOU WANT TO (blank on purpose, voluntary questions):
 *   gender
 *   ethnicity
 *   veteranStatus
 *   disabilityStatus
 *
 * GOES STALE -- RE-CHECK ROUGHLY EVERY SIX MONTHS:
 *   yearsOfExperience    -- currently 2, computed from Mar 2024 to Aug 2026.
 *   yearsBySkill.*       -- same clock, same rounding-down rule.
 *   experience[0].endDate / .current -- update when you change jobs, and add a
 *                           new object at the FRONT of the array (most recent
 *                           first is required by the filler).
 *
 * VERIFY ONCE:
 *   links.portfolio      -- 'https://vritravaibhav.github.io/portfolio' was
 *                           built from the bare domain on the resume. Open it
 *                           and confirm it resolves (no trailing slash issues).
 *   links.linkedin       -- built as 'https://www.linkedin.com/in/...'. Confirm
 *                           the vanity slug is exactly 'divyanshu-vaibhav'.
 *   personal.email       -- the resume reads 'divaibhavyanshu@gmail.com'. That
 *                           spelling looks like it may be a transposition of
 *                           'divyanshuvaibhav'. Confirm it before you send
 *                           applications to an address you cannot receive.
 *
 * SETTINGS WORTH A SECOND LOOK:
 *   noticePeriod         -- '30 days'. Change if your contract says 60 or 90.
 *   preferredLocations   -- Remote, Bangalore, Hyderabad, Pune, Dubai.
 *   howDidYouHear        -- 'Company website' is a safe default; change it when
 *                           you actually came from LinkedIn or a referral.
 *   salaryCurrency       -- 'INR'. Switch to 'AED' or 'USD' for those markets.
 *   coverLetters.*       -- read all three once in your own voice. They use
 *                           {{COMPANY}} and {{ROLE}} tokens and nothing else.
 * ========================================================================== */
