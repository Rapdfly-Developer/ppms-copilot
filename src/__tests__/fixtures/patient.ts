// Test fixtures — all data is synthetic.
// NEVER use real patient names, real clinical data, or real identifiers in tests.

import type { PatientDTO, VisitDTO, AppointmentDTO, TimelineEventDTO } from "@/lib/ppms-client";

export const FIXTURE_PATIENT: PatientDTO = {
  patientId: "pat-test-001",
  udid: "TEST-UDID-ALPHA-001",
  name: "Testpatient Alpha",  // fictional — never real
  age: 52,
  sex: "Male",
  category: "Glaucoma",
  complaint: "Blurred vision right eye",
  occupation: "Teacher",
  registeredOn: "2022-03-10T00:00:00Z",
};

export const FIXTURE_VISIT_CURRENT: VisitDTO = {
  visitId: "visit-current-001",
  date: "2024-06-15",
  visitType: "OPHTHALMIC",
  status: "COMPLETED",
  hospitalName: "Test Eye Hospital",
  doctorName: "Dr. Testdoctor",  // fictional
  chiefComplaint: "Routine glaucoma monitoring",
  hpi: "Patient reports stable vision on current drops. No headache.",
  pastMedicalHistory: "Hypertension — controlled",
  allergies: "Penicillin",
  nkda: false,
  vitals: { bp: "128/82", pulse: "74", temperature: "36.8", weight: "78 kg" },
  diagnoses: [
    {
      description: "Primary open-angle glaucoma",
      icd10Code: "H40.11",
      status: "ACTIVE",
      laterality: "Right eye",
      provisional: false,
      confirmed: true,
    },
  ],
  medications: [
    {
      drugName: "Timolol 0.5% eye drops",
      dosage: "1 drop",
      frequency: "BD",
      duration: "Ongoing",
      route: "Topical",
      laterality: "Both eyes",
    },
  ],
  investigations: [
    {
      testName: "Optical Coherence Tomography",
      category: "IMAGING",
      status: "ORDERED",
      priority: "ROUTINE",
      laterality: "Both eyes",
    },
  ],
  adviseNotes: "Continue current drops. Review after OCT results.",
  followUpDate: "2024-09-15",
  surgeryAdvised: false,
};

export const FIXTURE_VISIT_PREVIOUS: VisitDTO = {
  visitId: "visit-prev-001",
  date: "2023-12-10",
  visitType: "OPHTHALMIC",
  status: "COMPLETED",
  hospitalName: "Test Eye Hospital",
  doctorName: "Dr. Testdoctor",
  chiefComplaint: "Glaucoma check",
  diagnoses: [
    {
      description: "Primary open-angle glaucoma",
      icd10Code: "H40.11",
      status: "ACTIVE",
      laterality: "Right eye",
      provisional: false,
      confirmed: true,
    },
  ],
  medications: [
    {
      drugName: "Timolol 0.5% eye drops",
      dosage: "1 drop",
      frequency: "BD",
      duration: "Ongoing",
      route: "Topical",
      laterality: "Both eyes",
    },
  ],
  investigations: [],
  nkda: false,
  surgeryAdvised: false,
};

export const FIXTURE_APPOINTMENTS: AppointmentDTO[] = [
  {
    dateTime: "2024-09-15T10:00:00",
    visitType: "OPHTHALMIC",
    status: "SCHEDULED",
    hospitalName: "Test Eye Hospital",
  },
];

export const FIXTURE_TIMELINE: TimelineEventDTO[] = [
  { date: "2024-06-15", kind: "VISIT", label: "Glaucoma monitoring", detail: "Stable" },
  { date: "2023-12-10", kind: "VISIT", label: "Glaucoma check", detail: "No change" },
];

// A well-formed plugin token payload (expired=false for tests — exp in year 2099)
// Values are synthetic — not real doctorId/hospitalId/patientRef.
export const FIXTURE_TOKEN_PAYLOAD = {
  iss: "ppms-core",
  sub: "ppms.plugin.ai-clinical-copilot",
  jti: "test-jti-fixture-001",
  doctorId: "doctor-test-001",
  hospitalId: "hospital-test-001",
  patientRef: "TEST-UDID-ALPHA-001",
  visitId: "visit-current-001",
  pluginId: "ppms.plugin.ai-clinical-copilot",
  permissions: ["ai.copilot.summarize", "ai.copilot.draft", "ai.copilot.ask"],
  dataScopes: [
    "patient.demographics",
    "visit.history",
    "visit.context",
    "appointment.history",
    "patient.timeline",
  ],
  iat: 4070908800,  // 2099-01-01 — never expires in tests
  exp: 4070909400,  // + 600 seconds
};

// Build a fixture token string (header.payload.fakesig — NOT a real HMAC)
export function makeFixtureToken(overrides: Partial<typeof FIXTURE_TOKEN_PAYLOAD> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ ...FIXTURE_TOKEN_PAYLOAD, ...overrides }),
  ).toString("base64url");
  // Fake signature — the Copilot never verifies; PPMS Core does on API calls
  const sig = "fakesignaturefortestingonly";
  return `${header}.${payload}.${sig}`;
}

export const FIXTURE_TOKEN = makeFixtureToken();
export const FIXTURE_EXPIRED_TOKEN = makeFixtureToken({ exp: 1000 }); // Unix 1970 + 1000s
