import { normalize } from "./normalize";
import type { FieldDescriptor, Profile } from "./types";

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

/**
 * An address to open as a tab's own page. A desktop iCIMS page wraps its content in a frame of its own, and that
 * frame's address (`in_iframe=1`) opened on its own redirects back to the wrapper: AMD's runs looped there. Its mobile
 * view shows the content in the page itself.
 */
export function topLevelUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!/(^|\.)icims\.com$/i.test(u.hostname) || !/^\/jobs\//i.test(u.pathname)) return raw;
    u.searchParams.delete("in_iframe");
    u.searchParams.set("mobile", "true");
    u.searchParams.set("needsRedirect", "false");
    return u.toString();
  } catch {
    return raw;
  }
}

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
const RE_HAS_SIN =
  /\b(have|has|hold|holds|possess|possession of)\b[^?]*\b(sin|social insurance (number|no\b|#))|^\W*(a )?valid\b[^?]*\b(sin|social insurance (number|no\b|#))/i;
// Not the one asked: negated, a 9-series (temporary) SIN, or one asking for the number itself.
const RE_SIN_OTHER = /\bnot\b|n['’]t\b|\b9\b|\bnine\b|temporar|\bstart|\bbegin|expir|\b(enter|provide|list|what)\b/i;
// The whole of a need joined to the SIN ("… and a work permit?"), in Canada only: never "… and US work authorization?".
const RE_CA_WORK_RIGHT =
  /^(?:(?:do you (?:also )?(?:have|hold)|are you|you are|i am|am|have|hold|possess)\s+)?(?:an?\s+)?(?:valid\s+|current\s+)?(?:canadian\s+)?(?:work (?:permit|visa|authori[sz]ation)(?:\s*\/\s*(?:work\s+)?(?:permit|visa|authori[sz]ation))?|permit to work|(?:legally\s+)?(?:authori[sz]ed|eligible|entitled|permitted|able) to work)(?:\s+in canada)?$/i;
/** A Canadian citizen or permanent resident, authorized there: works in Canada with no permit to hold. */
export const needsNoCanadianPermit = (entries: Profile["workAuthorization"]["entries"]): boolean =>
  entries.some(
    (e) =>
      canonicalCountry(e.country) === "canada" &&
      e.authorized === "yes" &&
      /\b(citizen|permanent resident)/i.test(e.status) &&
      !/\bnot\b|n['’]t\b/i.test(e.status),
  );
/**
 * "Do you have a valid SIN?" (Social Insurance Number): the Profile's yes/no, else null and the field stays sensitive.
 * Only a choice, never a box for the number. A second need ("… and a work permit?") can't take Yes alone, unless it is
 * a Canadian work permit and `noPermitNeeded` (a citizen holds none, but may work: "No" reads as "can't work here"). A
 * choice ("SIN or SSN?") or a follow-on ("If not, can you get one?") can't take No alone.
 */
export function sinAnswer(
  f: Pick<FieldDescriptor, "label" | "kind" | "multiple">,
  hasSin: string,
  noPermitNeeded = false,
): "yes" | "no" | null {
  if (hasSin !== "yes" && hasSin !== "no") return null;
  if (!["checkbox", "radio_group", "select", "dropdown"].includes(f.kind) || f.multiple) return null;
  const [q, ...rest] = f.label.split("?");
  if (!RE_HAS_SIN.test(q) || RE_SIN_OTHER.test(q)) return null;
  if (hasSin === "yes") {
    if (!/\band\b|&/i.test(q)) return "yes";
    const parts = q
      .split(/,|\band\b|&/i)
      .map((p) => p.trim())
      .filter(Boolean);
    const met = (p: string) => /\b(sin|social insurance)\b/i.test(p) || RE_CA_WORK_RIGHT.test(p);
    return noPermitNeeded && parts.every(met) ? "yes" : null;
  }
  // An unchecked "I have a valid SIN" box says nothing.
  return f.kind === "checkbox" || /\bor\b|\//i.test(q) || /\w/.test(rest.join("?")) ? null : "no";
}
export const RE_CONSENT =
  /i (agree|acknowledge|certify|confirm|understand|accept|have read)|i['’]ve read|\b(agreement|understanding)\b|consent|terms|privacy (policy|notice)|attest|\b(true|accurate|correct),? and (complete|correct|accurate|your own)\b/i;
/** Consent that is not needed to apply: future/other roles, talent pools, marketing. */
/** A job board as where someone heard of a job (the profile's "How did you hear" source). */
export const RE_JOB_BOARD = /\b(linkedin|indeed|glassdoor|handshake|simplify|ziprecruiter|wellfound|angel ?list)\b/i;
/** A question asking how they heard of the job. */
export const RE_HEARD_Q = /\b(hear|heard|learn(ed)?) (about|of)\b|\bbrought you to\b/i;
// How they heard: options that claim a person, event or tie, or ask for more ("Other", "please specify").
const RE_HEARD_ODD =
  /^other\b|\b(referr\w*|employees?|colleagues?|friends?|family|recruit\w*|agency|staffing|events?|fairs?|conferences?|meetups?|hackathons?|former|previous(ly)?|alumn\w*|contacted|specify)\b/i;
const HEARD_SITE = /\b(web ?site|careers? (page|site|portal))\b/i;
const HEARD_BOARD = /\bjob ?(boards?|sites?|postings?|search)\b|\bonline (job|posting|ad)/i;
const HEARD_ONLINE = /\b(internet|online|search engine|google)\b/i;
const HEARD_SOCIAL = /\bsocial\b/i;
/**
 * How they heard, when no option is the profile's source (or it has none): the one naming it ("LinkedIn Jobs" for
 * LinkedIn), else the most usual plain answer (a job board first for a job board), else the first that claims nothing
 * odd. It hardly sways a hire, so never a referral, event or "Other" to explain. -1: none, or a yes/no question.
 */
export function commonHeardIndex(options: string[], heard: string): number {
  if (options.some((o) => /^(yes|no)\b/i.test(o.trim()))) return -1;
  const words = normalize(heard);
  const order = RE_JOB_BOARD.test(heard)
    ? [HEARD_BOARD, RE_JOB_BOARD, HEARD_SOCIAL, HEARD_SITE, HEARD_ONLINE]
    : [HEARD_SITE, HEARD_BOARD, RE_JOB_BOARD, HEARD_ONLINE, HEARD_SOCIAL];
  const tests = [
    (o: string) => !!words && ` ${normalize(o)} `.includes(` ${words} `),
    ...order.map((re) => (o: string) => re.test(o)),
    () => true,
  ];
  for (const t of tests) {
    const i = options.findIndex((o) => !!normalize(o) && !RE_HEARD_ODD.test(o) && t(o));
    if (i >= 0) return i;
  }
  return -1;
}
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
 * Profile consent ownership is independent of requiredness and whether a preference is set. null means no matching
 * topic; "" means a matching preference is unset. Combined consents decline if any topic is No, accept only if all
 * are Yes, and otherwise need the user's answer.
 */
export type ProfileConsents = Pick<
  Profile["background"],
  "consentToInterviewRecording" | "consentToAiReview" | "consentToJobOpportunities" | "consentToMarketing"
>;

export function profileConsentAnswer(text: string, prefs: ProfileConsents): "yes" | "no" | "" | null {
  const outreach = !RE_NOT_OPT_IN.test(text) && RE_OPT_IN.test(text);
  const answers = [
    RE_INTERVIEW_RECORDING.test(text) && prefs.consentToInterviewRecording,
    isAiReview(text) && prefs.consentToAiReview,
    outreach && RE_JOBS_TOPIC.test(text) && prefs.consentToJobOpportunities,
    outreach && RE_MARKETING_TOPIC.test(text) && prefs.consentToMarketing,
  ].filter((a) => a !== false);
  return !answers.length ? null : answers.includes("no") ? "no" : answers.every((a) => a === "yes") ? "yes" : "";
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
/**
 * A page confirming an application went through (YOLO's success check, and the user's own submissions). Not a
 * sentence saying when that will be: Intel's Workday heads a mid-form step "Follow the steps until you reach the
 * final page confirming that your application … has been successfully submitted", which ended a run as submitted.
 */
export const RE_APPLIED =
  /(?<!\b(until|once(?! again)|after|when|if|before)\b[^.!?\n]*)(thanks?( you)?( so much)? for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received|sent|completed?)\b|we('ve| have) (successfully )?received your application|successfully (applied|submitted)|your application (is|has been) (complete|submitted|received|on its way)|you('ve| have) (successfully )?applied|application submitted)/i;
/**
 * SuccessFactors' hosts, each serving many companies: SAP's own, its government cloud (L3Harris's
 * career-hcm20.ns2cloud.com) and sapsf (CMHC's career17.sapsf.com).
 */
export const RE_SF_HOST = /(^|\.)(successfactors\.(com|eu)|ns2cloud\.com|sapsf\.(com|eu|cn))$/i;
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
