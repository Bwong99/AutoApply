import { z } from "zod";

// Every leaf falls back to its empty default on invalid input, so a partially
// corrupt profile keeps all of its valid values instead of being reset.
const s = () => z.string().catch("");
const yn = () => z.enum(["yes", "no", ""]).catch("");
const ynd = () => z.enum(["yes", "no", "decline", ""]).catch("");
const strs = () => z.array(z.string()).catch([]);
function o<T extends z.ZodRawShape>(shape: T) {
  const base = z.object(shape);
  return base.catch(() => base.parse({}));
}
const arr = <T extends z.ZodType>(item: T) => z.array(item).catch([]);

export const FIELD_KINDS = [
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "month",
  "textarea",
  "contenteditable",
  "select",
  "multiselect",
  "radio_group",
  "checkbox_group",
  "checkbox",
  "dropdown",
  "typeahead",
  "file",
] as const;

export const LearnedAnswerSchema = z.object({
  id: z.string(),
  question: z.string(),
  normalizedQuestion: z.string(),
  kind: z.enum(FIELD_KINDS),
  options: z.array(z.string()).optional(),
  answer: z.string(),
  host: z.string().catch(""),
  createdAt: z.number().catch(0),
  lastUsedAt: z.number().catch(0),
});

export const WorkAuthEntrySchema = o({
  country: s(),
  authorized: yn(),
  status: s(),
  requiresSponsorshipNow: yn(),
  requiresSponsorshipFuture: yn(),
  notes: s(),
});
export const EducationSchema = o({
  school: s(),
  degree: s(),
  major: s(),
  minor: s(),
  startDate: s(),
  endDate: s(),
  expectedGraduation: s(),
  currentlyEnrolled: yn(),
  gpa: s(),
  gpaScale: s(),
  yearLevel: s(),
  creditsCompleted: s(),
  honors: s(),
  relevantCourses: strs(),
});
export const ExperienceSchema = o({
  title: s(),
  company: s(),
  location: s(),
  employmentType: s(),
  startDate: s(),
  endDate: s(),
  current: z.boolean().catch(false),
  description: s(),
});
export const ProjectSchema = o({ name: s(), url: s(), description: s(), tech: strs() });
export const ExtracurricularSchema = o({
  role: s(),
  organization: s(),
  location: s(),
  startDate: s(),
  endDate: s(),
  current: z.boolean().catch(false),
  description: s(),
});

export const ProfileSchema = o({
  personal: o({
    firstName: s(),
    middleName: s(),
    lastName: s(),
    preferredName: s(),
    pronouns: s(),
    email: s(),
    phone: o({ countryCode: s(), number: s(), type: z.enum(["mobile", "home", ""]).catch("") }),
    dateOfBirth: s(),
    address: o({
      line1: s(),
      line2: s(),
      city: s(),
      region: s(),
      regionCode: s(),
      postalCode: s(),
      country: s(),
      countryCode: s(),
    }),
    links: o({
      linkedin: s(),
      github: s(),
      portfolio: s(),
      website: s(),
      other: arr(o({ label: s(), url: s() })),
    }),
  }),
  workAuthorization: o({
    entries: arr(WorkAuthEntrySchema),
    securityClearance: s(),
    over18: yn(),
    noOtherCitizenship: yn(),
  }),
  education: arr(EducationSchema),
  highSchool: o({ name: s(), graduationYear: s() }),
  coop: o({
    inCoopProgram: yn(),
    programName: s(),
    workTermNumber: s(),
    availableTerms: strs(),
    acceptableTermLengths: strs(),
    studentNumber: s(),
  }),
  experience: arr(ExperienceSchema),
  projects: arr(ProjectSchema),
  extracurriculars: arr(ExtracurricularSchema),
  skills: o({
    technical: strs(),
    soft: strs(),
    languages: arr(o({ language: s(), proficiency: s() })),
    certifications: arr(o({ name: s(), issuer: s(), date: s() })),
  }),
  preferences: o({
    willingToRelocate: yn(),
    relocationNotes: s(),
    preferredLocations: strs(),
    workArrangement: z.array(z.enum(["onsite", "hybrid", "remote"])).catch([]),
    earliestStartDate: s(),
    availableUntil: s(),
    desiredCompensation: o({
      amount: s(),
      currency: s(),
      period: z.enum(["hour", "year", ""]).catch(""),
      // Where in a posting's pay range to answer; "" always answers `amount`, which is also the lowest answer.
      strategy: z.enum(["", "min", "q1", "mid", "q3", "max"]).catch(""),
      notes: s(),
    }),
    willingToTravelPercent: s(),
    noticePeriod: s(),
    employmentTypes: strs(),
    hoursPerWeek: s(),
    canWorkWeekends: yn(),
    canWorkShifts: yn(),
  }),
  background: o({
    hasDriversLicense: yn(),
    hasVehicle: yn(),
    consentToBackgroundCheck: yn(),
    consentToDrugTest: yn(),
    criminalRecord: ynd(),
    previouslyEmployedHereDefault: yn(),
    relativesEmployedHereDefault: yn(),
    nonCompeteOrRestrictions: s(),
    offerDeadlines: s(),
    outsideActivities: s(),
    governmentTies: s(),
    consentToInterviewRecording: yn(),
    consentToAiReview: yn(),
    consentToJobOpportunities: yn(),
    consentToMarketing: yn(),
  }),
  referral: o({ howDidYouHearDefault: s(), referrerName: s() }),
  demographics: o({
    gender: s(),
    transgender: ynd(),
    sexualOrientation: s(),
    raceEthnicity: strs(),
    hispanicLatino: ynd(),
    veteranStatus: s(),
    disability: ynd(),
    indigenous: ynd(),
    visibleMinority: ynd(),
    firstGenProfessional: ynd(),
    lgbtq: ynd(),
  }),
  essayGuidance: o({
    aboutMe: s(),
    careerGoals: s(),
    strengthsToEmphasize: s(),
    tone: s(),
    thingsToAvoid: s(),
    coverLetterTemplate: s(),
  }),
  resumeText: s(),
  learnedAnswers: z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      list.flatMap((x) => {
        const r = LearnedAnswerSchema.safeParse(x);
        return r.success ? [r.data] : [];
      }),
    ),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type LearnedAnswer = z.infer<typeof LearnedAnswerSchema>;

export const emptyProfile = (): Profile => ProfileSchema.parse({});

/** Empty profile as compact JSON example for the résumé-parsing prompt (Appendix A.4). */
export function profileExampleJson(): string {
  const { learnedAnswers: _l, resumeText: _r, ...rest } = emptyProfile();
  const ex = {
    ...rest,
    education: [EducationSchema.parse({})],
    experience: [ExperienceSchema.parse({})],
    projects: [ProjectSchema.parse({})],
    extracurriculars: [ExtracurricularSchema.parse({})],
  };
  return JSON.stringify(ex);
}
