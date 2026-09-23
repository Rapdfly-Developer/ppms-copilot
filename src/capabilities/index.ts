// Capability definitions — the 9 clinical AI actions the Copilot can perform.
// Each capability declares exactly what data it needs, its token budget, and
// which PPMS permission the doctor must hold.

export const CAPABILITIES = {
  PATIENT_SNAPSHOT: "PATIENT_SNAPSHOT",
  PREVIOUS_VISIT_SUMMARY: "PREVIOUS_VISIT_SUMMARY",
  HISTORY_SUMMARY: "HISTORY_SUMMARY",
  TIMELINE_SUMMARY: "TIMELINE_SUMMARY",
  IMPORTANT_CHANGES: "IMPORTANT_CHANGES",
  NOTE_ASSISTANCE: "NOTE_ASSISTANCE",
  FOLLOW_UP_SUMMARY: "FOLLOW_UP_SUMMARY",
  DIFFERENTIAL_DIAGNOSIS: "DIFFERENTIAL_DIAGNOSIS",
  MEDICATIONS_SUMMARY: "MEDICATIONS_SUMMARY",
  INVESTIGATIONS_SUMMARY: "INVESTIGATIONS_SUMMARY",
  ASSESSMENT_CONTEXT: "ASSESSMENT_CONTEXT",
  SUGGESTED_QUESTIONS: "SUGGESTED_QUESTIONS",
  EXAM_GUIDANCE: "EXAM_GUIDANCE",
  REFRACTIVE_GUIDANCE: "REFRACTIVE_GUIDANCE",
  PLAN_GUIDANCE: "PLAN_GUIDANCE",
  INVESTIGATION_GUIDANCE: "INVESTIGATION_GUIDANCE",
  DIAGNOSIS_COMPARISON: "DIAGNOSIS_COMPARISON",
  QUESTION: "QUESTION",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const ALL_CAPABILITIES: Capability[] = Object.values(CAPABILITIES);

export type ContextIncludes = {
  demographics: boolean;
  currentVisit: boolean;
  visitHistory: boolean;
  appointments: boolean;
  timeline: boolean;
};

export type CapabilityConfig = {
  label: string;
  description: string;
  includes: ContextIncludes;
  // Maximum visits to fetch from visit history (0 = all available, up to 20)
  visitLimit: number;
  maxTokens: number;
  // Permission string that must appear in the plugin token's permissions[]
  permission: string;
  // Whether this capability produces a draft for doctor review and EMR insertion
  producesDraft: boolean;
  draftType?: "consultation_note" | "follow_up_summary";
  // Reasoning depth — used to select model tier and temperature
  reasoningEffort: "medium" | "high";
  // "fast" = COPILOT_FAST_MODEL, "reasoning" = COPILOT_REASONING_MODEL
  modelTier: "fast" | "reasoning";
};

export const CAPABILITY_CONFIG: Record<Capability, CapabilityConfig> = {
  PATIENT_SNAPSHOT: {
    label: "AI Patient Snapshot",
    description: "Quick overview of the patient and current visit",
    includes: { demographics: true, currentVisit: true, visitHistory: false, appointments: false, timeline: false },
    visitLimit: 1,
    maxTokens: 700,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  PREVIOUS_VISIT_SUMMARY: {
    label: "Previous Visit Summary",
    description: "Summary of the patient's most recent previous visits",
    includes: { demographics: true, currentVisit: false, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 3,
    maxTokens: 1000,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  HISTORY_SUMMARY: {
    label: "Clinical History Summary",
    description: "Full structured summary of documented medical history",
    includes: { demographics: true, currentVisit: false, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 5,
    maxTokens: 1200,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  TIMELINE_SUMMARY: {
    label: "Clinical Timeline",
    description: "Chronological summary of all clinical events",
    includes: { demographics: true, currentVisit: false, visitHistory: false, appointments: true, timeline: true },
    visitLimit: 0,
    maxTokens: 1200,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  IMPORTANT_CHANGES: {
    label: "Important Changes / Attention",
    description: "Key changes and items requiring attention between visits",
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 6,
    maxTokens: 1400,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "high",
    modelTier: "reasoning",
  },
  NOTE_ASSISTANCE: {
    label: "Consultation Note Draft",
    description: "AI-assisted SOAP note draft for doctor review and confirmation",
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 3,
    maxTokens: 1400,
    permission: "ai.copilot.draft",
    producesDraft: true,
    draftType: "consultation_note",
    reasoningEffort: "high",
    modelTier: "reasoning",
  },
  FOLLOW_UP_SUMMARY: {
    label: "Follow-up Summary",
    description: "Structured summary for patient follow-up or referral",
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: true, timeline: false },
    visitLimit: 3,
    maxTokens: 1400,
    permission: "ai.copilot.summarize",
    producesDraft: true,
    draftType: "follow_up_summary",
    reasoningEffort: "high",
    modelTier: "reasoning",
  },
  DIFFERENTIAL_DIAGNOSIS: {
    label: "Differential Diagnosis",
    description: "AI-generated list of possible diagnostic considerations for doctor review, based only on documented findings",
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 3,
    maxTokens: 1400,
    permission: "ai.copilot.draft",
    producesDraft: false,
    reasoningEffort: "high",
    modelTier: "reasoning",
  },
  MEDICATIONS_SUMMARY: {
    label: "Current Medications",
    description: "All medications documented at this visit",
    includes: { demographics: true, currentVisit: true, visitHistory: false, appointments: false, timeline: false },
    visitLimit: 1,
    maxTokens: 600,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  INVESTIGATIONS_SUMMARY: {
    label: "Investigations & Reports",
    description: "Investigations ordered across visits and their documented status",
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 3,
    maxTokens: 700,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  ASSESSMENT_CONTEXT: {
    label: "Diagnoses & Assessment",
    description: "Current documented diagnoses and overall clinical assessment context",
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 6,
    maxTokens: 800,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  SUGGESTED_QUESTIONS: {
    label: "Documentation Gaps",
    description: "Information absent from the documented record that may be clinically relevant",
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 3,
    maxTokens: 500,
    permission: "ai.copilot.summarize",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  EXAM_GUIDANCE: {
    label: "Exam Guidance",
    description:
      "Correlates documented general-visit findings with associated exam findings not yet documented, by anatomical segment",
    // Every documented field this capability correlates from (chief complaint,
    // HPI, past medical history, allergies, vitals, reported medications) lives
    // on the current visit only — no visit history needed.
    includes: { demographics: true, currentVisit: true, visitHistory: false, appointments: false, timeline: false },
    visitLimit: 1,
    // 1400: was 900, which live-testing against the real Groq API showed was
    // too tight for openai/gpt-oss-120b — 3 of 8 real calls hit max_tokens
    // (1 empty response, 2 truncated mid-sentence), all misreported to the
    // doctor as a generic "clinical safety" failure (see errorFrame below —
    // now fixed to surface the real per-code message). Matched to
    // DIFFERENTIAL_DIAGNOSIS's budget, which does comparably open-ended
    // reasoning over a similar amount of documented input.
    maxTokens: 1400,
    permission: "ai.copilot.draft",
    producesDraft: false,
    // medium, not high: on Groq's gpt-oss models "high" maps to the most
    // expensive reasoning_effort, and the hidden reasoning tokens used up the
    // whole maxTokens budget live, leaving empty output (RESPONSE_EMPTY).
    reasoningEffort: "medium",
    modelTier: "reasoning",
  },
  REFRACTIVE_GUIDANCE: {
    label: "Refractive Guidance",
    description:
      "Correlates documented refraction and visual acuity into a per-eye refractive interpretation, plus routing guidance for the remaining Ophthalmic sub-tabs",
    // Refraction, visual acuity, and the sub-tab documentation-status flags
    // are all current-visit-only — no visit history needed.
    includes: { demographics: true, currentVisit: true, visitHistory: false, appointments: false, timeline: false },
    visitLimit: 1,
    // 1600: a starting estimate, not yet live-tested — above EXAM_GUIDANCE's
    // 1400 to cover two full eye blocks (vs. one segment pair) plus the
    // routing block. Treat as provisional; adjust based on real Groq
    // behavior the same way EXAM_GUIDANCE's budget was tuned twice already.
    maxTokens: 1600,
    permission: "ai.copilot.draft",
    producesDraft: false,
    // medium, not high: on Groq's gpt-oss models "high" maps to the most
    // expensive reasoning_effort, and the hidden reasoning tokens used up the
    // whole maxTokens budget live, leaving empty output (RESPONSE_EMPTY).
    reasoningEffort: "medium",
    modelTier: "reasoning",
  },
  PLAN_GUIDANCE: {
    label: "Plan Guidance",
    description:
      "Correlates documented medication/diagnosis progression, patient-reassurance guidance, and (when a confident match exists) a cited government scheme for the Plan tab",
    // Progression description needs visit history (for medicationDeltas/
    // diagnosisDeltas); the govt scheme match only needs the current visit's
    // documented diagnoses.
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 6,
    // 1400: matched to EXAM_GUIDANCE's budget — two required free-text blocks
    // (progression, comforting guidance) plus an optional but fully
    // verbatim-dictated third block (govt scheme) that costs little since
    // its content is copied, not composed. Provisional — live-test before
    // treating as final, same as every other capability's budget so far.
    maxTokens: 1400,
    permission: "ai.copilot.draft",
    producesDraft: false,
    reasoningEffort: "high",
    modelTier: "reasoning",
  },
  INVESTIGATION_GUIDANCE: {
    label: "Investigation Guidance",
    description:
      "Correlates documented findings into investigations commonly associated with the clinical picture, for the Investigations tab",
    // Needs visit history: previous investigations (to avoid suggesting a
    // duplicate) and diagnosis/history context, same reasoning as
    // DIFFERENTIAL_DIAGNOSIS's config.
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 3,
    // 1800: was 1400 (matched to DIFFERENTIAL_DIAGNOSIS's budget), bumped
    // after live-testing against the real Groq API showed 1400 was too
    // tight for a genuinely verbose response — one real call (AMD/central
    // vision distortion scenario, 5 correlated suggestions) hit max_tokens
    // and was truncated mid-response. Unlike Differential Diagnosis's short
    // one-line reasons, each suggestion here carries a longer correlative
    // rationale sentence by design, so more items overruns the shared
    // budget faster. Matched to REFRACTIVE_GUIDANCE's provisional estimate.
    maxTokens: 1800,
    permission: "ai.copilot.draft",
    producesDraft: false,
    reasoningEffort: "high",
    modelTier: "reasoning",
  },
  DIAGNOSIS_COMPARISON: {
    label: "Diagnosis Comparison",
    description:
      "Assesses whether the documented diagnosis is consistent with documented findings, plus a citation of the same-generation Differential Diagnosis reasoning, for the Assessment tab",
    // Only needs current-visit chief complaint/HPI/findings and the
    // documented diagnosis itself — the Differential Diagnosis list it also
    // surfaces is consumed via post-hoc application code (the same-generation
    // differentialDiagnosisItems/reasons), never fed back into this prompt.
    includes: { demographics: true, currentVisit: true, visitHistory: true, appointments: false, timeline: false },
    visitLimit: 3,
    // 1200 includes the fast model's hidden reasoning tokens. The original
    // 500-token budget truncated even a basic cataract sanity case.
    maxTokens: 1200,
    permission: "ai.copilot.draft",
    producesDraft: false,
    // fast/medium, not high/reasoning: a narrow single-field judgment doesn't
    // need the deeper reasoning tier open-ended differential reasoning does.
    reasoningEffort: "medium",
    modelTier: "fast",
  },
  QUESTION: {
    label: "Ask a Question",
    description: "Ask a clinical question about this patient's documented record",
    includes: { demographics: true, currentVisit: false, visitHistory: true, appointments: false, timeline: true },
    visitLimit: 5,
    maxTokens: 1000,
    permission: "ai.copilot.ask",
    producesDraft: false,
    reasoningEffort: "medium",
    modelTier: "fast",
  },
};

export function isValidCapability(cap: unknown): cap is Capability {
  return typeof cap === "string" && ALL_CAPABILITIES.includes(cap as Capability);
}

export function getCapabilityConfig(cap: Capability): CapabilityConfig {
  return CAPABILITY_CONFIG[cap];
}
