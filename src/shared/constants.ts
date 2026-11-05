import { normalize } from "./normalize";

// ---------- Gemini ----------
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** §10.3.2: model ids matching any of these are not text-in/text-out task models. */
export const EXCLUDED_MODEL_PATTERNS = [
  "embed",
  "aqa",
  "imagen",
  "veo",
  "lyria",
  "image",
  "tts",
  "audio",
  "live",
  "transcribe",
  "translate",
  "omni",
  "robotics",
  "computer-use",
  "gemma",
  "banana",
  "deep-research",
  "learnlm",
];

// ---------- ATS hosts (Appendix C.1) ----------
export const ATS_HOSTS = [
  "greenhouse.io",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "lever.co",
  "jobs.lever.co",
  "myworkdayjobs.com",
  "myworkday.com",
  "workday.com",
  "ashbyhq.com",
  "jobs.ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "taleo.net",
  "successfactors.com",
  "successfactors.eu",
  "bamboohr.com",
  "workable.com",
  "apply.workable.com",
  "recruitee.com",
  "breezy.hr",
  "applytojob.com",
  "jazzhr.com",
  "teamtailor.com",
  "personio.de",
  "personio.com",
  "rippling-ats.com",
  "ats.rippling.com",
  "dover.com",
  "wellfound.com",
  "oraclecloud.com",
  "ultipro.com",
  "paylocity.com",
  "adp.com",
  "pinpointhq.com",
  "hirebridge.com",
  "comeet.com",
  "freshteam.com",
  "zohorecruit.com",
  "clearcompany.com",
  "avature.net",
  "eightfold.ai",
  "phenompeople.com",
];

/** Hosts that only count as ATS when the path also matches. */
export const ATS_PATH_REQUIREMENTS: Record<string, RegExp> = {
  "oraclecloud.com": /\/hcmUI\//,
  "adp.com": /recruit/i,
};

export function isAtsHost(host: string, path: string): boolean {
  const h = host.toLowerCase();
  return ATS_HOSTS.some(
    (a) => (h === a || h.endsWith("." + a)) && (!ATS_PATH_REQUIREMENTS[a] || ATS_PATH_REQUIREMENTS[a].test(path)),
  );
}

export const RE_RESUME_FILE = /r[ée]sum[ée]|\bcv\b|cover letter/i;
export const RE_RESUME_ONLY = /r[ée]sum[ée]|\bcv\b/i;
export const RE_COVER_LETTER = /cover letter/i;

// ---------- Scanning (§11.3, §11.6, §18) ----------
// Workday's sign-up bot trap: "Enter website. This input is for robots only, do not enter if you're human."
export const RE_SKIP_LABEL =
  /captcha|honeypot|leave this (field )?(blank|empty)|for robots|do not (enter|fill)[^.]*human|beecatcher|\bif you('re| are) (a )?(ro)?bot\b|\b(ro)?bots? only\b|\bhumans? (should|must) (leave|not)\b|\bif you('re| are) (a )?human,? (leave|do not|don't)\b|\banti-?spam\b|\bspam (trap|check|protection|prevention)\b|\bdo not (fill|enter|type|change|alter|touch) (in )?(this|anything)\b/i;
/** Honeypot inputs by name or id: Formspree's _gotcha, Akismet's ak_hp_*, Rails' contact_me_by_fax_only, hp_* fields. */
export const RE_TRAP_NAME =
  /(^|[\s_-])(_?gotcha|honey_?pot\w*|honey|hpot|hp|ak_hp\w*|bot_?(field|check|trap|catcher)|leave_?(this_?)?(blank|empty)|(contact_me_by_)?fax_?only|no_?spam)(?=[\s_-]|$)/i;
export const RE_COOKIE_CONTAINER = /cookie|consent-banner|onetrust|gdpr/i;
export const RE_NEWSLETTER = /newsletter|subscribe/i;
export const RE_SENSITIVE_LABEL =
  /card number|\bcvv\b|\bcvc\b|expiry|iban|routing|\bsin\b|social insurance|social security|ssn|passport (number|no)/i;
export const RE_CONSENT =
  /i (agree|acknowledge|certify|confirm|understand|accept|have read)|i['’]ve read|\b(agreement|understanding)\b|consent|terms|privacy (policy|notice)|attest|\b(true|accurate|correct),? and (complete|correct|accurate|your own)\b/i;
/** Consent that is not needed to apply: future/other roles, talent pools, marketing. */
/** A job board as where someone heard of a job (the profile's "How did you hear" source). */
export const RE_JOB_BOARD = /\b(linkedin|indeed|glassdoor|handshake|simplify|ziprecruiter|wellfound|angel ?list)\b/i;
export const RE_OPTIONAL_CONSENT =
  /\b(future|other|additional|similar|relevant)\b(\s+\w+){0,2}\s+(opportunit\w*|openings|vacancies)|considered for (other|future)|talent (community|pool|network)|job alerts?|newsletter|marketing (e-?mails?|communications?|messages|materials)|unsubscribe|keep me (informed|updated|posted)|text messag\w*|\btext (you|me)\b|\bsms\b|alerts? for (similar|new|other|relevant|future) (jobs?|roles?|positions?|openings)|stay (up to date|in touch|informed|connected)\b|\b(retain|retention)\b[^.]*\b(additional|further|extra|extended|longer)\b/i;
/** Opt-in to AI notetakers or recorded interviews: answered from the profile, not as a consent. Not "transcript". */
export const RE_INTERVIEW_RECORDING =
  /\bnote-?tak|\b(record|transcrib)\w*\b[^.]*\b(interview|conversation|meeting)s?\b|\b(interview|conversation|meeting)s?\b[^.]*\b(record|transcrib)\w*/i;
const AI_TERM = String.raw`\b(AI|artificial intelligence|machine learning)\b`;
const AI_ASSESS = String.raw`\b(assess|evaluat|review|screen|analy[sz]|process|rank|scor)\w*`;
const RE_AI_REVIEW = new RegExp(
  String.raw`${AI_TERM}[^.?]*${AI_ASSESS}|${AI_ASSESS}[^.?]*\b(using|with|by|through|via)\b[^.?]*${AI_TERM}`,
  "i",
);
/**
 * A request to let AI tools assess the application (ADI: "may use artificial intelligence (AI) tools to assess how
 * your candidate information aligns …"): answered from the profile when set. Not the candidate's own AI work ("Have
 * you used AI to screen candidates?").
 */
export const isAiReview = (text: string): boolean =>
  RE_AI_REVIEW.test(text) &&
  /\b(candidat|applica|your (personal )?(data|information|profile|r[eé]sum[eé]|cv|submission|skills))/i.test(text) &&
  !/\b(have|did) you\b[^?.]*\b(use|used|built|developed|implemented)\b/i.test(text);
/** Asks to be sent, told or signed up for something: what makes a job or marketing topic an opt-in. */
const RE_OPT_IN =
  /\b(receiv\w*|send|sent|contact\w*|e-?mail(s|ed|ing)?|texts?|call(s|ed)?|notif\w*|inform(ed)?|updates?|updated|alerts?|news|newsletters?|messages?|communications?|outreach|subscri\w*|opt(ed|ing)?[\s-]?in|sign(ed|ing)? (me )?up|join|keep (me|you|my|your|in touch)|stay|invit\w*|mailing list|reach (out|you|me)|hear (more )?(about|from|of)|consider(ed|ing)? (you |me )?for|shar(e|ed|ing)|talent (community|pool|network|pipeline))\b/i;
/** Other or future roles than this one; not "this and other positions" in an attestation (no opt-in wording). */
const RE_JOBS_TOPIC = new RegExp(
  String.raw`\b(new|future|other|additional|similar|relevant|upcoming|open|matching|suitable|alternative)\b(\s+(?!(this|that|the|your|my)\b)[\w'’-]+){0,3}?\s+(opportunit(y|ies)|openings?|vacanc(y|ies)|roles?|positions?|jobs?|careers?|postings?)\b` +
    String.raw`|(?<!\b(this|that|the|your)\s)\b(job|career|employment|work)\s+(opportunities|openings|vacancies|postings|listings)\b` +
    String.raw`|\b(job|career|hiring|recruit\w*)\s+(alerts?|newsletters?|notifications?|recommendations?|matches|news|updates|events?)\b` +
    String.raw`|talent (community|pool|network|pipeline)|considered for (other|future|additional|similar|alternative|new)` +
    String.raw`|\b(roles?|positions?|jobs?|opportunit(y|ies)|openings)\s+(that|which)\s+(may\s+)?(match|fit|suit|align)`,
  "i",
);
/** Marketing, advertising or sales outreach; not a marketing or sales job ("marketing roles", "sales experience"). */
const RE_MARKETING_TOPIC = new RegExp(
  String.raw`(\b(marketing|advertis\w*|promotion(al|s)?|direct mail)|\bcommercial (e-?mails?|communications?|messages?|offers|purposes)` +
    String.raw`|\bsales (e-?mails?|communications?|calls?|messages?|outreach|materials?|team|representatives?|purposes)` +
    String.raw`|(?<!\b(job|career|talent|hiring|recruit\w*)\s)\bnewsletters?|\b(special|exclusive|promotional|partner|personali[sz]ed) offers` +
    String.raw`|\bproduct (news|updates|announcements|launches)|\bcompany (news|announcements)|mailing list|\b(our|new|latest) (products?|services|offerings|solutions))\b` +
    String.raw`(?!\s+([\w-]+\s+)?(roles?|positions?|jobs?|opportunit(y|ies)|openings?|vacanc(y|ies)|careers?|experience|background|department|team|manager|skills?|degree)\b)`,
  "i",
);
/** Asks about the candidate ("Have you been contacted about other roles?", "experience in marketing"), not to opt in. */
const RE_NOT_OPT_IN =
  /\b(have|has|had|did|were|was) you\b|\bdo you (have|hold|possess)\b|\b(experience|expertise|proficien\w*|familiar\w*) (in|with)\b/i;
/**
 * The profile's answer to an opt-in to hear about new job opportunities or marketing: "no" if it declines a topic the
 * question names, "yes" if it accepts every one, else "" (no such topic, or unset: left to the consent settings).
 */
export function optInAnswer(
  text: string,
  prefs: { consentToJobOpportunities: "yes" | "no" | ""; consentToMarketing: "yes" | "no" | "" },
): "yes" | "no" | "" {
  if (!prefs.consentToJobOpportunities && !prefs.consentToMarketing) return "";
  if (RE_NOT_OPT_IN.test(text) || !RE_OPT_IN.test(text)) return "";
  const answers = [
    RE_JOBS_TOPIC.test(text) && prefs.consentToJobOpportunities,
    RE_MARKETING_TOPIC.test(text) && prefs.consentToMarketing,
  ].filter((a) => a !== false);
  return answers.includes("no") ? "no" : answers.length && answers.every((a) => a === "yes") ? "yes" : "";
}
/** Answer choices of a consent question ("Consent" / "Do Not Consent"). */
export const RE_CONSENT_YES = /^(yes[\s,:–—-]+)?(i )?(consent|agree|acknowledge|accept)/i;
export const RE_CONSENT_NO = /^(no[\s,:–—-]+)?(i )?(do not|don['’]t|decline|disagree|refuse|withhold)\b/i;
export const RE_HELPER_CLASS = /help|hint|description|desc|subtext|instructions/i;
/** Buttons/links the extension must never click (§18.1). */
/** How long a YOLO run in a visible tab waits for the user to solve a CAPTCHA. */
export const CAPTCHA_WAIT_MS = 10 * 60_000;
/** How long a YOLO run in a background tab gives a CAPTCHA to pass by itself before handing it to the user. */
export const CAPTCHA_SELF_CLEAR_MS = 20_000;
/** How long a YOLO run blocked on a verification email waits for it to arrive. */
export const EMAIL_WAIT_MS = 5 * 60_000;
/** A timer firing at least this late means the computer slept meanwhile (YOLO's watchdog ticks every 30 s). */
export const SLEPT_MS = 60_000;
/** A page confirming an application went through (YOLO's success check, and the user's own submissions). */
export const RE_APPLIED =
  /thanks?( you)?( so much)? for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received|sent|completed?)\b|we('ve| have) (successfully )?received your application|successfully (applied|submitted)|your application (is|has been) (complete|submitted|received|on its way)|you('ve| have) (successfully )?applied|application submitted/i;
export const RE_FORBIDDEN_CLICK = /submit|next|continue|apply|save|sign ?in|log ?in|sign ?up|register|finish|review/i;
/** Button texts that are never answer choices (used to reject button-style choice groups). */
export const RE_NAV_BUTTON =
  /submit|next|continue|apply|save|sign ?in|log ?in|sign ?up|register|finish|review|back|previous|cancel|close|delete|remove|upload|attach|search|\bedit\b|\badd\b/i;
export const RE_UPLOAD_BUTTON = /upload|attach|browse|choose file|select file/i;
/** A control label that only names the upload action ("Attach") or the widget (BambooHR's "file-input"), not the question. */
export const RE_ACTION_LABEL =
  /^((attach|upload|browse|choose|select)( (a )?files?)?( or (drag and )?drop (it|them|files?) here)?|file[-_ ]?input)$/i;
export const RE_DROPZONE = /drag|drop|upload|attach/i;
/** Uploaders that parse a résumé to prefill the form rather than attach it. */
export const RE_AUTOFILL_UPLOAD = /\bauto-?(fill|complete)/i;
export const RE_TYPEAHEAD_HINT =
  /location|city|school|university|college|company|employer|search|autocomplete|typeahead/i;
// SuccessFactors' selects open on "No Selection".
export const RE_PLACEHOLDER_OPTION = /^(select|choose|please select|no selection|--|—|-)(\b|\s|$)/i;
export const RE_NO_OPTIONS = /^(no options|no results|no matches|nothing found|loading|searching)/i;

/** Appendix C.3 */
export const DROPDOWN_TRIGGER_SELECTORS = [
  "[role=combobox]",
  "[aria-haspopup=listbox]",
  '[class*="select__control"]',
  '[class*="Select-control"]',
  '[class*="MuiSelect"]',
  '[class*="MuiAutocomplete"]',
  ".ant-select-selector",
  ".choices__inner",
  ".select2-selection",
  ".vs__dropdown-toggle",
  '[class*="dropdown-toggle"]',
  // Not "select-files" upload buttons (Workday): clicking one opens the OS file picker.
  '[data-automation-id*="select" i]:not([data-automation-id*="file" i])',
  '[data-testid*="select" i]:not([data-testid*="file" i])',
].join(",");

export const OPTION_SELECTORS = [
  "[role=option]",
  '[class*="select__option"]',
  '[class*="Select-option"]',
  // react-select without a class prefix or option roles (Epic Games): ids are its own.
  '[id^="react-select-"][id*="-option-"]',
  ".MuiAutocomplete-option",
  ".MuiMenuItem-root",
  ".ant-select-item-option",
  ".choices__item--choice",
  ".select2-results__option",
  ".select2-result-selectable", // select2 3.x (legacy Greenhouse's school search)
  ".vs__dropdown-option",
  "li[data-value]",
  ".dropdown-location", // Lever's location suggestions
  '[data-automation-id*="promptOption" i]',
  // Selects drawn as an ARIA menu (BambooHR's fab-Select: a button opening role=menu items).
  "[role=menuitemradio]",
  "[role=menuitem]",
].join(",");

// ---------- Deterministic mapping (§13.2, Appendix C.2) ----------
export type DetKey =
  | "fullName"
  | "legalName"
  | "firstName"
  | "middleName"
  | "lastName"
  | "preferredName"
  | "pronouns"
  | "email"
  | "phone"
  | "phoneNational"
  | "phoneCountryCode"
  | "phoneExtension"
  | "streetAddress"
  | "line1"
  | "line2"
  | "city"
  | "region"
  | "postalCode"
  | "country"
  | "countryCode"
  | "location"
  | "url"
  | "linkedin"
  | "github"
  | "portfolio"
  | "dateOfBirth";

export const AUTOCOMPLETE_MAP: Record<string, DetKey> = {
  name: "fullName",
  "given-name": "firstName",
  "additional-name": "middleName",
  "family-name": "lastName",
  nickname: "preferredName",
  email: "email",
  tel: "phone",
  "tel-national": "phoneNational",
  "tel-country-code": "phoneCountryCode",
  "tel-extension": "phoneExtension",
  "street-address": "streetAddress",
  "address-line1": "line1",
  "address-line2": "line2",
  "address-level2": "city",
  "address-level1": "region",
  "postal-code": "postalCode",
  "country-name": "country",
  country: "countryCode",
  url: "url",
  bday: "dateOfBirth",
};

/** A résumé entry's section ("Work Experience 2", Greenhouse's "Employment"): its fields describe that entry. */
export const RE_ENTRY_SECTION = /^(employment|work experience|experience|education)(?: (\d+))?$/i;

/** Word boundaries were added to state/region/unit/apt so "personal statement" etc. don't match. */
export const LABEL_RULES: [RegExp, DetKey][] = [
  // Westinghouse's "Electronic Signature : Please sign with your full name (first name and last name or surname)" got
  // the last name. Not "Signature Date".
  [/^(?!.*\bdate\b).*(\bsignature\b|\bsign (here )?with your (full |legal )?name\b)/i, "fullName"],
  // Not "Legal First and Last Name" (it got the first name alone).
  [/^first\s*name|given name|legal first(?! (and|&) last)/i, "firstName"],
  [/^last\s*name|legal last|^(?!.*\b(signature|full name)\b).*(surname|family name)/i, "lastName"],
  // Sentry's "First and Last Name" went to the AI, which added the middle name.
  [/^(full\s*)?name$|^(legal )?first (and|&) last name$/i, "fullName"],
  [/\blegal name\b/i, "legalName"],
  [/preferred (first )?name/i, "preferredName"],
  // Not a school address (Jane Street's "university email" got the personal one): the AI decides. Nor someone else's,
  // or a second one (Duolingo's "Alternate Email" got the same address again).
  [
    /^(?!.*\b(school|university|college|student|\.?edu|alternat(e|ive)|secondary|backup|emergency|referr(er|al)|reference|parent|guardian)\b).*e-?mail/i,
    "email",
  ],
  // Not "phonetically" (Akuna's name pronunciation got the phone number), nor "Phone Extension" (it got the number too),
  // nor someone else's or a second number.
  [
    /^(?!.*\b(ext(ension)?|alternat(e|ive)|secondary|backup|emergency|referr(er|al)|reference|parent|guardian)\b).*(phone(?!tic)|mobile|\bcell)/i,
    "phone",
  ],
  [/\b(phone|mobile|tel(ephone)?)\b.*\bext(ension)?\b|^ext(ension)?\.?$/i, "phoneExtension"],
  [/country code|dialing code/i, "phoneCountryCode"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  [/portfolio|personal (web)?site|website/i, "portfolio"],
  // "Your current city, state, and country" also matches region, so it is ambiguous and goes to the AI.
  [/^city|\btown\b|\bcity\b.*\b(state|province|region|country)\b/i, "city"],
  // Sprout Social: "Can you please confirm your current location? Note: … must be based in Poland". Not "Is your …?".
  [
    /^(current )?location( \(city\))?$|^where are you (currently )?(located|based)\b|^(?!(is|are|do|does)\b)[^?]*\byour current location\?/i,
    "location",
  ],
  [/postal|zip/i, "postalCode"],
  [/\bpronouns?\b/i, "pronouns"],
  [/^address( line)? ?1|street address/i, "line1"],
  [/address( line)? ?2|\bapt\b|\bsuite\b|\bunit\b/i, "line2"],
  // Not the verb: "Please state your full legal name" (or salary, reason…) is no question about the province.
  [/\b(province|region)\b|\bstate\b(?! (your|the|any|whether|how|why|what|if|briefly)\b)/i, "region"],
  [/^country$/i, "country"],
];

// ---------- Country / region aliases (§13.1) ----------
/** ISO-3166 alpha-2 + alpha-3 pairs, packed as "ADAND AEARE …". */
const ISO_PAIRS =
  "ADANDAEAREAFAFGAGATGAIAIAALALBAMARMAOAGOAQATAARARGASASMATAUTAUAUSAWABWAXALAAZAZEBABIHBBBRBBDBGDBEBELBFBFABGBGRBHBHRBIBDIBJBENBLBLMBMBMUBNBRNBOBOLBQBESBRBRABSBHSBTBTNBVBVTBWBWABYBLRBZBLZCACANCCCCKCDCODCFCAFCGCOGCHCHECICIVCKCOKCLCHLCMCMRCNCHNCOCOLCRCRICUCUBCVCPVCWCUWCXCXRCYCYPCZCZEDEDEUDJDJIDKDNKDMDMADODOMDZDZAECECUEEESTEGEGYEHESHERERIESESPETETHFIFINFJFJIFKFLKFMFSMFOFROFRFRAGAGABGBGBRGDGRDGEGEOGFGUFGGGGYGHGHAGIGIBGLGRLGMGMBGNGINGPGLPGQGNQGRGRCGSSGSGTGTMGUGUMGWGNBGYGUYHKHKGHMHMDHNHNDHRHRVHTHTIHUHUNIDIDNIEIRLILISRIMIMNININDIOIOTIQIRQIRIRNISISLITITAJEJEYJMJAMJOJORJPJPNKEKENKGKGZKHKHMKIKIRKMCOMKNKNAKPPRKKRKORKWKWTKYCYMKZKAZLALAOLBLBNLCLCALILIELKLKALRLBRLSLSOLTLTULULUXLVLVALYLBYMAMARMCMCOMDMDAMEMNEMFMAFMGMDGMHMHLMKMKDMLMLIMMMMRMNMNGMOMACMPMNPMQMTQMRMRTMSMSRMTMLTMUMUSMVMDVMWMWIMXMEXMYMYSMZMOZNANAMNCNCLNENERNFNFKNGNGANINICNLNLDNONORNPNPLNRNRUNUNIUNZNZLOMOMNPAPANPEPERPFPYFPGPNGPHPHLPKPAKPLPOLPMSPMPNPCNPRPRIPSPSEPTPRTPWPLWPYPRYQAQATREREUROROURSSRBRURUSRWRWASASAUSBSLBSCSYCSDSDNSESWESGSGPSHSHNSISVNSJSJMSKSVKSLSLESMSMRSNSENSOSOMSRSURSSSSDSTSTPSVSLVSXSXMSYSYRSZSWZTCTCATDTCDTFATFTGTGOTHTHATJTJKTKTKLTLTLSTMTKMTNTUNTOTONTRTURTTTTOTVTUVTWTWNTZTZAUAUKRUGUGAUMUMIUSUSAUYURYUZUZBVAVATVCVCTVEVENVGVGBVIVIRVNVNMVUVUTWFWLFWSWSMXKXKKYEYEMYTMYTZAZAFZMZMBZWZWE";

const COUNTRY_EXTRAS: Record<string, string> = {
  usa: "US",
  "united states of america": "US",
  america: "US",
  "u s": "US",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "south korea": "KR",
  "republic of korea": "KR",
  korea: "KR",
  "north korea": "KP",
  russia: "RU",
  "russian federation": "RU",
  "czech republic": "CZ",
  turkey: "TR",
  turkiye: "TR",
  "ivory coast": "CI",
  burma: "MM",
  myanmar: "MM",
  "hong kong": "HK",
  macau: "MO",
  macao: "MO",
  vietnam: "VN",
  "viet nam": "VN",
  laos: "LA",
  iran: "IR",
  syria: "SY",
  taiwan: "TW",
  holland: "NL",
  "the netherlands": "NL",
  uae: "AE",
  emirates: "AE",
  palestine: "PS",
  vatican: "VA",
  "vatican city": "VA",
  bolivia: "BO",
  venezuela: "VE",
  tanzania: "TZ",
  moldova: "MD",
  micronesia: "FM",
  swaziland: "SZ",
  eswatini: "SZ",
  "cape verde": "CV",
  "east timor": "TL",
  "timor leste": "TL",
  macedonia: "MK",
  "north macedonia": "MK",
  "republic of the congo": "CG",
  drc: "CD",
  "democratic republic of the congo": "CD",
  "congo kinshasa": "CD",
  "congo brazzaville": "CG",
  "saint lucia": "LC",
  "st lucia": "LC",
  "saint kitts and nevis": "KN",
  "st kitts and nevis": "KN",
  "saint vincent and the grenadines": "VC",
  "st vincent and the grenadines": "VC",
  "people s republic of china": "CN",
  "peoples republic of china": "CN",
  prc: "CN",
};

const REGIONS: [string, string][] = [
  ["AB", "Alberta"],
  ["BC", "British Columbia"],
  ["MB", "Manitoba"],
  ["NB", "New Brunswick"],
  ["NL", "Newfoundland and Labrador"],
  ["NS", "Nova Scotia"],
  ["NT", "Northwest Territories"],
  ["NU", "Nunavut"],
  ["ON", "Ontario"],
  ["PE", "Prince Edward Island"],
  ["QC", "Quebec"],
  ["SK", "Saskatchewan"],
  ["YT", "Yukon"],
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["DC", "District of Columbia"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
  ["PR", "Puerto Rico"],
];

let countryAliases: Map<string, string> | null = null;
let regionAliases: Map<string, string> | null = null;

/** normalized alias → normalized canonical English country name. Built lazily from Intl.DisplayNames. */
export function COUNTRY_ALIASES(): Map<string, string> {
  if (countryAliases) return countryAliases;
  const m = new Map<string, string>();
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const canonOf = (a2: string) => normalize(names.of(a2) ?? a2);
  for (let i = 0; i < ISO_PAIRS.length; i += 5) {
    const a2 = ISO_PAIRS.slice(i, i + 2);
    const canon = canonOf(a2);
    m.set(a2.toLowerCase(), canon);
    m.set(ISO_PAIRS.slice(i + 2, i + 5).toLowerCase(), canon);
    m.set(canon, canon);
  }
  for (const [alias, a2] of Object.entries(COUNTRY_EXTRAS)) m.set(normalize(alias), canonOf(a2));
  countryAliases = m;
  return m;
}

/** normalized alias (code or name) → normalized canonical region name (Canada + US). */
export function REGION_ALIASES(): Map<string, string> {
  if (regionAliases) return regionAliases;
  const m = new Map<string, string>();
  for (const [code, name] of REGIONS) {
    m.set(code.toLowerCase(), normalize(name));
    m.set(normalize(name), normalize(name));
  }
  m.set("quebec", "quebec");
  m.set("pei", "prince edward island");
  m.set("newfoundland", "newfoundland and labrador");
  m.set("washington dc", "district of columbia");
  regionAliases = m;
  return m;
}

export const canonicalCountry = (s: string): string | null => COUNTRY_ALIASES().get(normalize(s)) ?? null;
export const canonicalRegion = (s: string): string | null => REGION_ALIASES().get(normalize(s)) ?? null;
/** The normalized country of a Canadian province or US state (REGIONS lists Canada's 13 first). */
export const regionCountry = (s: string): string | null => {
  const c = canonicalRegion(s);
  return c ? (REGIONS.findIndex(([, n]) => normalize(n) === c) < 13 ? "canada" : "united states") : null;
};
export const regionCode = (s: string): string | null => {
  const c = canonicalRegion(s);
  return c ? (REGIONS.find(([, n]) => normalize(n) === c)?.[0] ?? null) : null;
};

/** Tech hubs a job location may name alone ("Hybrid - San Francisco"), by normalized name. */
export const HUBS: Record<string, string> = {
  "san francisco": "united states",
  "sf bay area": "united states",
  "bay area": "united states",
  "new york": "united states",
  "new york city": "united states",
  nyc: "united states",
  seattle: "united states",
  austin: "united states",
  boston: "united states",
  chicago: "united states",
  "los angeles": "united states",
  "palo alto": "united states",
  "mountain view": "united states",
  "menlo park": "united states",
  sunnyvale: "united states",
  "san jose": "united states",
  "foster city": "united states",
  "redwood city": "united states",
  denver: "united states",
  atlanta: "united states",
  toronto: "canada",
  vancouver: "canada",
  montreal: "canada",
  waterloo: "canada",
  ottawa: "canada",
  london: "united kingdom",
  dublin: "ireland",
  berlin: "germany",
  munich: "germany",
  paris: "france",
  amsterdam: "netherlands",
  zurich: "switzerland",
  stockholm: "sweden",
  bangalore: "india",
  bengaluru: "india",
  hyderabad: "india",
  tokyo: "japan",
  sydney: "australia",
  "tel aviv": "israel",
  lisbon: "portugal",
  madrid: "spain",
  barcelona: "spain",
  warsaw: "poland",
  krakow: "poland",
  prague: "czechia",
  vienna: "austria",
  copenhagen: "denmark",
  oslo: "norway",
  helsinki: "finland",
  milan: "italy",
  edinburgh: "united kingdom",
  manchester: "united kingdom",
  singapore: "singapore",
  "hong kong": "hong kong",
  seoul: "south korea",
  "sao paulo": "brazil",
  "mexico city": "mexico",
};

/** The province or state of HUBS' Canadian and US cities. */
export const HUB_REGIONS: Record<string, string> = {
  toronto: "ON",
  waterloo: "ON",
  ottawa: "ON",
  vancouver: "BC",
  montreal: "QC",
  "san francisco": "CA",
  "sf bay area": "CA",
  "bay area": "CA",
  "los angeles": "CA",
  "palo alto": "CA",
  "mountain view": "CA",
  "menlo park": "CA",
  sunnyvale: "CA",
  "san jose": "CA",
  "foster city": "CA",
  "redwood city": "CA",
  "new york": "NY",
  "new york city": "NY",
  nyc: "NY",
  seattle: "WA",
  austin: "TX",
  boston: "MA",
  chicago: "IL",
  denver: "CO",
  atlanta: "GA",
};

/**
 * A generated cover letter's word target with the one-page limit on (settings.coverLetterOnePage): four or five
 * paragraphs this long fill about 34 of the PDF's 44 lines (background/yolo/pdf.ts), leaving room for an address
 * block and the AI running over its target.
 */
export const ONE_PAGE_WORDS = 400;
