// Declarative layout of the profile editor: one sub-page per top-level §7 group.
import {
  EducationSchema,
  ExperienceSchema,
  ExtracurricularSchema,
  ProjectSchema,
  WorkAuthEntrySchema,
} from "../shared/profileSchema";

export type FieldSpec = { path: string; label: string; help: string; extra?: FieldSpec; wide?: true | "full" } & (
  | { k: "text" | "email" | "tel" | "url" | "date" | "month" | "textarea" | "yn" | "ynd" | "tags" | "bool" }
  | { k: "select" | "multi"; options: [string, string][] }
  | { k: "decl" | "tagsdecl" }
);

export interface CardSpec {
  card: true;
  path: string;
  title: string;
  make: () => object;
  /** An inner array stacks its fields in one grid cell. */
  fields: (FieldSpec | FieldSpec[])[];
}

export interface GroupSpec {
  id: string;
  title: string;
  intro: string;
  items: (FieldSpec | CardSpec)[];
}

const t = (path: string, label: string, help: string, k: FieldSpec["k"] = "text") =>
  ({ path, label, help, k }) as FieldSpec;

export const PROFILE_GROUPS: GroupSpec[] = [
  {
    id: "personal",
    title: "Personal",
    intro: "Contact details. These fill instantly without AI when a field's label or autocomplete hint is unambiguous.",
    items: [
      t("personal.firstName", "First name", "Your legal first name, used for “First name” fields."),
      t("personal.middleName", "Middle name", "Used only when a form asks for a middle name."),
      t("personal.lastName", "Last name", "Your legal last name / surname."),
      t(
        "personal.preferredName",
        "Preferred name",
        "Filled into “Preferred name” fields; falls back to your first name.",
      ),
      t("personal.pronouns", "Pronouns", "Free text, e.g. “she/her”. Filled only where pronouns are asked."),
      t("personal.email", "Email", "The address employers should contact.", "email"),
      t(
        "personal.phone.countryCode",
        "Phone country code",
        "Like +1. Used when a form has a separate country-code field.",
        "tel",
      ),
      t(
        "personal.phone.number",
        "Phone number",
        "Digits only is best; it is reformatted to match each form's placeholder.",
        "tel",
      ),
      {
        k: "select",
        path: "personal.phone.type",
        label: "Phone type",
        help: "Answers “Phone type” dropdowns.",
        options: [
          ["", "Unset"],
          ["mobile", "Mobile"],
          ["home", "Home"],
        ],
      },
      t(
        "personal.dateOfBirth",
        "Date of birth",
        "Rarely asked. Filled only when a field explicitly asks for birth date.",
        "date",
      ),
      t("personal.address.line1", "Address line 1", "Street address."),
      t("personal.address.line2", "Address line 2", "Apartment, suite or unit."),
      t("personal.address.city", "City", "City you live in."),
      t("personal.address.region", "Province / state", "Full name, e.g. British Columbia."),
      t(
        "personal.address.regionCode",
        "Province / state code",
        "Short code, e.g. BC. Used when a field only fits 2–3 characters.",
      ),
      t("personal.address.postalCode", "Postal / ZIP code", "Filled into postal or ZIP fields."),
      t("personal.address.country", "Country", "Full country name, e.g. Canada."),
      t("personal.address.countryCode", "Country code", "Two-letter ISO code, e.g. CA."),
      t("personal.links.linkedin", "LinkedIn URL", "Filled into LinkedIn fields.", "url"),
      t("personal.links.github", "GitHub URL", "Filled into GitHub fields.", "url"),
      t("personal.links.portfolio", "Portfolio URL", "Used for portfolio / personal website fields.", "url"),
      t("personal.links.website", "Website", "Used for website fields when no portfolio is set.", "url"),
      {
        card: true,
        path: "personal.links.other",
        title: "Other link",
        make: () => ({ label: "", url: "" }),
        fields: [t("label", "Label", "What the link is, e.g. “Kaggle”."), t("url", "URL", "The full address.", "url")],
      },
    ],
  },
  {
    id: "workAuthorization",
    title: "Work authorization",
    intro: "Eligibility questions are answered only from these explicit values; anything unset is flagged for you.",
    items: [
      {
        card: true,
        path: "workAuthorization.entries",
        title: "Country",
        make: () => WorkAuthEntrySchema.parse({}),
        fields: [
          t("country", "Country", "The country this entry applies to, e.g. Canada."),
          t(
            "authorized",
            "Legally authorized to work there now",
            "Answers “Are you legally authorized to work in …?”.",
            "yn",
          ),
          t("status", "Status", "e.g. Citizen, Permanent resident, Study permit (co-op eligible), Work permit."),
          t("requiresSponsorshipNow", "Requires sponsorship now", "Answers “Do you require visa sponsorship?”.", "yn"),
          t(
            "requiresSponsorshipFuture",
            "Requires sponsorship in future",
            "Answers “Will you require sponsorship in the future?”.",
            "yn",
          ),
          t("notes", "Notes", "Extra context the AI may use, e.g. permit expiry."),
        ],
      },
      t(
        "workAuthorization.securityClearance",
        "Security clearance",
        "Leave empty if none; describe it if you hold one.",
      ),
      t("workAuthorization.over18", "18 or older", "Answers “Are you at least 18 years old?”.", "yn"),
      t(
        "workAuthorization.noOtherCitizenship",
        "I do not have citizenship in other countries",
        "Only the countries above with status Citizen. Answers “Are you a citizen of Cuba, Iran, …?”.",
        "yn",
      ),
    ],
  },
  {
    id: "education",
    title: "Education",
    intro: "The first entry is treated as your current/most relevant program.",
    items: [
      {
        card: true,
        path: "education",
        title: "School",
        make: () => EducationSchema.parse({}),
        fields: [
          t("school", "School", "Full name, e.g. University of British Columbia."),
          t("degree", "Degree", "e.g. Bachelor of Science."),
          t("major", "Major", "Your main field of study."),
          t("minor", "Minor", "Optional."),
          t("startDate", "Start", "When you started.", "month"),
          t("endDate", "End", "When you finished (leave empty if ongoing).", "month"),
          t("expectedGraduation", "Expected graduation", "Answers graduation-date questions.", "month"),
          t("currentlyEnrolled", "Currently enrolled", "Answers “Are you currently a student?”.", "yn"),
          t("gpa", "GPA", "As you would write it, e.g. 3.8."),
          t("gpaScale", "GPA scale", "e.g. 4.0 or 4.33."),
          t("yearLevel", "Year level", "e.g. 3rd year."),
          t("creditsCompleted", "Credits completed", "Answers “How many credits have you completed?”, e.g. 90."),
          t("honors", "Honours / awards", "Dean's list, scholarships, etc."),
          t("relevantCourses", "Relevant courses", "Press Enter after each course.", "tags"),
        ],
      },
      t("highSchool.name", "High school", "Asked by some internship forms; kept apart from your degrees."),
      t("highSchool.graduationYear", "High school graduation year", "e.g. 2024."),
    ],
  },
  {
    id: "coop",
    title: "Co-op / internship",
    intro: "Answers co-op specific questions such as work-term number and available terms.",
    items: [
      t("coop.inCoopProgram", "In a co-op program", "Answers “Are you enrolled in a co-op program?”.", "yn"),
      t("coop.programName", "Program name", "e.g. UBC Science Co-op."),
      t("coop.workTermNumber", "Work term number", "e.g. 2nd work term."),
      t("coop.availableTerms", "Available terms", "e.g. Jan–Apr 2027. Press Enter after each.", "tags"),
      t("coop.acceptableTermLengths", "Acceptable term lengths", "e.g. 4 months, 8 months.", "tags"),
      t("coop.studentNumber", "Student number", "Filled only where a student number is requested."),
    ],
  },
  {
    id: "experience",
    title: "Experience",
    intro: "Used for “current employer” style questions and as essay material.",
    items: [
      {
        card: true,
        path: "experience",
        title: "Role",
        make: () => ExperienceSchema.parse({}),
        fields: [
          t("title", "Title", "Your job title."),
          t("company", "Company", "Employer name."),
          t("location", "Location", "City, region."),
          t("employmentType", "Type", "e.g. Co-op, Internship, Part-time."),
          t("startDate", "Start", "Start month.", "month"),
          {
            ...t("endDate", "End", "End month (leave empty if current).", "month"),
            extra: t("current", "I currently work here", "", "bool"),
          },
          {
            ...t("description", "Description", "What you did and achieved; essays draw from this.", "textarea"),
            wide: true,
          },
        ],
      },
    ],
  },
  {
    id: "projects",
    title: "Projects",
    intro: "Projects the AI may mention in essays.",
    items: [
      {
        card: true,
        path: "projects",
        title: "Project",
        make: () => ProjectSchema.parse({}),
        fields: [
          [t("name", "Name", "Project name."), t("url", "URL", "Link to code or demo.", "url")],
          t("tech", "Tech", "Languages and tools. Press Enter after each.", "tags"),
          { ...t("description", "Description", "What it does and your role.", "textarea"), wide: true },
        ],
      },
    ],
  },
  {
    id: "extracurriculars",
    title: "Extracurriculars",
    intro: "Clubs, teams, volunteering and other activities the AI may mention in essays.",
    items: [
      {
        card: true,
        path: "extracurriculars",
        title: "Activity",
        make: () => ExtracurricularSchema.parse({}),
        fields: [
          t("role", "Role", "e.g. President, Member, Volunteer."),
          t("organization", "Organization", "Club, team or group name."),
          t("location", "Location", "City, region."),
          t("startDate", "Start", "Start month.", "month"),
          {
            ...t("endDate", "End", "End month (leave empty if ongoing).", "month"),
            extra: t("current", "I'm currently involved", "", "bool"),
          },
          {
            ...t("description", "Description", "What you did and achieved; essays draw from this.", "textarea"),
            wide: true,
          },
        ],
      },
    ],
  },
  {
    id: "skills",
    title: "Skills",
    intro: "Used for skill checklists and essays.",
    items: [
      t("skills.technical", "Technical skills", "e.g. Python, React. Press Enter after each.", "tags"),
      t("skills.soft", "Soft skills", "e.g. Communication, Leadership.", "tags"),
      {
        card: true,
        path: "skills.languages",
        title: "Language",
        make: () => ({ language: "", proficiency: "" }),
        fields: [
          t("language", "Language", "e.g. French."),
          t("proficiency", "Proficiency", "e.g. Native, Fluent, Conversational."),
        ],
      },
      {
        card: true,
        path: "skills.certifications",
        title: "Certification",
        make: () => ({ name: "", issuer: "", date: "" }),
        fields: [
          t("name", "Name", "Certification name."),
          t("issuer", "Issuer", "Who issued it."),
          t("date", "Date", "When you earned it.", "month"),
        ],
      },
    ],
  },
  {
    id: "preferences",
    title: "Preferences",
    intro: "Availability, location and compensation answers.",
    items: [
      t("preferences.willingToRelocate", "Willing to relocate", "Answers relocation questions by meaning.", "yn"),
      t("preferences.relocationNotes", "Relocation notes", "e.g. Anywhere in Canada."),
      t("preferences.preferredLocations", "Preferred locations", "Cities or regions. Press Enter after each.", "tags"),
      {
        k: "multi",
        path: "preferences.workArrangement",
        label: "Work arrangement",
        help: "Arrangements you accept.",
        options: [
          ["onsite", "On-site"],
          ["hybrid", "Hybrid"],
          ["remote", "Remote"],
        ],
      },
      t("preferences.earliestStartDate", "Earliest start date", "Answers availability / start-date questions.", "date"),
      t("preferences.availableUntil", "Available until", "End of your availability (e.g. end of term).", "date"),
      t(
        "preferences.desiredCompensation.amount",
        "Lowest pay",
        "The least you'd enter for desired compensation. A number, e.g. 25 or 80000.",
      ),
      t("preferences.desiredCompensation.currency", "Currency", "e.g. CAD."),
      {
        k: "select",
        path: "preferences.desiredCompensation.period",
        label: "Per",
        help: "Hourly or yearly; converted (40 h × 52 weeks) when a form asks for the other.",
        options: [
          ["", "Unset"],
          ["hour", "Hour"],
          ["year", "Year"],
        ],
      },
      {
        k: "select",
        path: "preferences.desiredCompensation.strategy",
        label: "Pay to enter",
        help: "When the posting lists a pay range; otherwise your lowest pay. Never below your lowest pay.",
        options: [
          ["", "Always my lowest pay"],
          ["min", "Range minimum"],
          ["q1", "Lower quarter of the range"],
          ["mid", "Range midpoint"],
          ["q3", "Upper quarter of the range"],
          ["max", "Range maximum"],
        ],
      },
      t("preferences.desiredCompensation.notes", "Compensation notes", "e.g. Negotiable."),
      t("preferences.willingToTravelPercent", "Willing to travel (%)", "e.g. 25."),
      t("preferences.noticePeriod", "Notice period", "e.g. Immediately, 2 weeks."),
      t("preferences.employmentTypes", "Employment types", "e.g. Co-op, Internship, Full-time.", "tags"),
      t("preferences.hoursPerWeek", "Hours per week", "e.g. 40."),
      t("preferences.canWorkWeekends", "Can work weekends", "Answers weekend availability questions.", "yn"),
      t("preferences.canWorkShifts", "Can work shifts", "Answers shift-work questions.", "yn"),
    ],
  },
  {
    id: "background",
    title: "Background",
    intro: "Legal and background-check answers. Unset values are always flagged for you.",
    items: [
      t("background.hasDriversLicense", "Driver's license", "Answers “Do you have a valid driver's license?”.", "yn"),
      t("background.hasVehicle", "Access to a vehicle", "Answers vehicle-access questions.", "yn"),
      t(
        "background.consentToBackgroundCheck",
        "Consent to background check",
        "Answers background-check consent questions.",
        "yn",
      ),
      t("background.consentToDrugTest", "Consent to drug test", "Answers drug-test consent questions.", "yn"),
      t(
        "background.criminalRecord",
        "Criminal record",
        "“Decline” picks a decline-to-answer option when offered.",
        "ynd",
      ),
      t(
        "background.previouslyEmployedHereDefault",
        "Previously worked at the company",
        "Default for “Have you worked here before?”.",
        "yn",
      ),
      t(
        "background.relativesEmployedHereDefault",
        "Relatives work at the company",
        "Default for “Do you know anyone who works here?”.",
        "yn",
      ),
      t(
        "background.nonCompeteOrRestrictions",
        "Non-compete / restrictions",
        "Describe any agreements; write “None” if you have none",
      ),
      t(
        "background.offerDeadlines",
        "Offer deadlines",
        "Answers “Do you have any upcoming offer deadlines?”. Write “None” if you have none; empty leaves it to you.",
      ),
      t(
        "background.outsideActivities",
        "Outside business activities",
        "Advisory, consulting or board roles, side businesses you'd keep. Write “None” if none.",
      ),
      t(
        "background.governmentTies",
        "Government employment / officials",
        "Current or past government work, or close ties to government officials. Write “None” if none.",
      ),
      t(
        "background.consentToInterviewRecording",
        "Consent to interview recording",
        "Answers opt-ins to AI notetakers or recorded / transcribed interviews.",
        "yn",
      ),
      t(
        "background.consentToAiReview",
        "Consent to AI review of application",
        "Answers whether AI tools may assess your application (“By selecting Yes, you consent to the use of AI tools…”).",
        "yn",
      ),
      t(
        "background.consentToJobOpportunities",
        "New job opportunities",
        "Answers optional opt-ins to hear about other or future roles (job alerts, talent community). Required ones and Unset follow Behavior's consent settings.",
        "yn",
      ),
      t(
        "background.consentToMarketing",
        "Marketing communications",
        "Answers optional opt-ins to marketing, advertising, sales or newsletter emails. Required ones and Unset follow Behavior's consent settings.",
        "yn",
      ),
    ],
  },
  {
    id: "referral",
    title: "Referral",
    intro: "How you usually find jobs.",
    items: [
      t(
        "referral.howDidYouHearDefault",
        "How did you hear about us (default)",
        "e.g. LinkedIn, School job board. Matched to the closest option.",
      ),
      t(
        "referral.referrerName",
        "Referrer name",
        "Leave empty if you have no referrer; referral fields are then skipped.",
      ),
    ],
  },
  {
    id: "demographics",
    title: "Self-identification",
    intro:
      "Voluntary EEO / self-identification answers. “Decline” selects the prefer-not-to-say option; unset fields are flagged.",
    items: [
      t("demographics.gender", "Gender", "Free text, or tick Decline.", "decl"),
      t("demographics.transgender", "Transgender", "Answers transgender identity questions.", "ynd"),
      t("demographics.sexualOrientation", "Sexual orientation", "Free text, or tick Decline.", "decl"),
      t("demographics.raceEthnicity", "Race / ethnicity", "One or more; or tick Decline.", "tagsdecl"),
      t("demographics.hispanicLatino", "Hispanic or Latino", "US EEO question.", "ynd"),
      t(
        "demographics.veteranStatus",
        "Veteran status",
        "e.g. “I am not a protected veteran”, or tick Decline.",
        "decl",
      ),
      t("demographics.disability", "Disability", "Answers disability self-identification.", "ynd"),
      t("demographics.indigenous", "Indigenous", "Canadian self-identification question.", "ynd"),
      t("demographics.visibleMinority", "Visible minority", "Canadian self-identification question.", "ynd"),
      t(
        "demographics.firstGenProfessional",
        "First-generation professional",
        "Answers “I identify as a first-generation professional”.",
        "ynd",
      ),
      t("demographics.lgbtq", "LGBTQ+ community", "Answers LGBTQ+ / 2SLGBTQIA+ community questions.", "ynd"),
    ],
  },
  {
    id: "essayGuidance",
    title: "Essay guidance",
    intro: "Shapes AI-drafted answers to open-ended questions. Drafts are always marked “AI draft – review”.",
    items: [
      t("essayGuidance.aboutMe", "About me", "A 1–2 paragraph bio the AI may draw from.", "textarea"),
      t(
        "essayGuidance.careerGoals",
        "Career goals",
        "Where you want to go; used for “why this role” answers.",
        "textarea",
      ),
      t("essayGuidance.strengthsToEmphasize", "Strengths to emphasize", "What drafts should highlight.", "textarea"),
      t("essayGuidance.tone", "Tone", "e.g. confident, warm, concise."),
      t("essayGuidance.thingsToAvoid", "Things to avoid", "Topics or phrases drafts must not use.", "textarea"),
      {
        ...t(
          "essayGuidance.coverLetterTemplate",
          "Cover letter template",
          "Optional base cover letter the AI adapts when writing one: cover-letter text boxes, and uploads when Documents has no cover letter (Behavior / YOLO settings).",
          "textarea",
        ),
        wide: "full",
      },
    ],
  },
];
