// PPMS Core API client.
//
// Security invariants:
//   - Base URL comes from PPMS_CORE_URL env var (server-only). The browser
//     cannot supply or change the target host.
//   - The token is forwarded as-is — this project does NOT verify the signature.
//     PPMS Core validates the token on every /api/v1/* call (6-layer auth).
//   - All PPMS error messages are discarded; only structured CopilotErrors
//     propagate to the caller — vendor text must never reach the client.
//   - Clinical data is never cached (cache: 'no-store').

import { CopilotError } from "./errors";
import { getPpmsCoreUrl } from "./env";
import { logger } from "./logger";

// ── DTO types — mirror PPMS Core's plugin-framework/gateway/data.ts ──────────

export type PatientDTO = {
  patientId: string;
  udid: string;
  name: string; // NOT sent to AI — stripped in context/pii.ts
  age: number;
  sex: string;
  category: string;
  complaint: string;
  occupation: string;
  registeredOn: string;
};

export type MedicationDTO = {
  drugName: string;
  dosage: string;
  frequency: string;
  duration: string;
  route: string;
  laterality?: string;
  instructions?: string;
};

export type DiagnosisDTO = {
  description: string;
  icd10Code?: string;
  status: string;
  laterality?: string;
  provisional: boolean;
  confirmed: boolean;
};

export type InvestigationDTO = {
  testName: string;
  category: string;
  status: string;
  priority: string;
  laterality?: string;
  notes?: string;
};

export type VisitDTO = {
  visitId: string;
  date: string;
  visitType: string;
  status: string;
  hospitalName: string;
  doctorName: string; // NOT sent to AI
  chiefComplaint?: string;
  hpi?: string;
  pastMedicalHistory?: string;
  allergies?: string;
  nkda: boolean;
  reportedMedications?: string;
  vitals?: {
    bp?: string;
    pulse?: string;
    temperature?: string;
    weight?: string;
  };
  diagnoses: DiagnosisDTO[];
  medications: MedicationDTO[];
  investigations: InvestigationDTO[];
  adviseNotes?: string;
  followUpDate?: string;
  procedureName?: string;
  surgeryAdvised: boolean;
  advisedSurgeryName?: string;
};

export type AppointmentDTO = {
  dateTime: string;
  visitType: string;
  status: string;
  hospitalName: string;
};

export type TimelineEventDTO = {
  date: string;
  kind: "VISIT" | "SURGERY" | "ADMISSION" | "APPOINTMENT";
  label: string;
  detail?: string;
};

// ── Internal HTTP helper ──────────────────────────────────────────────────────

async function ppmsGet<T>(token: string, path: string): Promise<T> {
  const baseUrl = getPpmsCoreUrl();
  const url = `${baseUrl}${path}`;
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch {
    // Network-level failure (DNS, TCP) — do not log the URL (contains patientRef)
    logger.error("ppms_network_error", {
      endpoint: path.split("?")[0].replace(/\/[^/]+/g, "/[id]"),
      durationMs: Date.now() - start,
    });
    throw new CopilotError("PPMS_UNAVAILABLE", "PPMS Core is unreachable", 503);
  }

  const durationMs = Date.now() - start;
  logger.info("ppms_api_response", {
    endpoint: path.split("?")[0].replace(/\/[^/]+/g, "/[id]"),
    status: res.status,
    durationMs,
  });

  if (res.status === 401) {
    throw new CopilotError("TOKEN_EXPIRED", "Plugin token expired or invalid", 401);
  }
  if (res.status === 403) {
    throw new CopilotError("PLUGIN_DISABLED", "Plugin not enabled for this doctor", 403);
  }
  if (res.status === 404) {
    throw new CopilotError("PATIENT_NOT_FOUND", "Patient not found or not accessible", 404);
  }
  if (!res.ok) {
    throw new CopilotError("PPMS_API_ERROR", `PPMS API error: ${res.status}`, 502);
  }

  // Discard response body on parse failure rather than forwarding any PPMS messages
  try {
    return (await res.json()) as T;
  } catch {
    throw new CopilotError("PPMS_API_ERROR", "Invalid response from PPMS Core", 502);
  }
}

// ── Public API functions ──────────────────────────────────────────────────────

export async function getPatient(
  token: string,
  patientRef: string,
): Promise<PatientDTO> {
  const data = await ppmsGet<{ patient: PatientDTO }>(
    token,
    `/api/v1/patients/${encodeURIComponent(patientRef)}`,
  );
  return data.patient;
}

export async function getVisits(
  token: string,
  patientRef: string,
  limit: number,
): Promise<VisitDTO[]> {
  const safeLimit = Math.min(Math.max(1, limit), 20);
  const data = await ppmsGet<{ visits: VisitDTO[] }>(
    token,
    `/api/v1/patients/${encodeURIComponent(patientRef)}/visits?limit=${safeLimit}`,
  );
  return data.visits;
}

export async function getVisit(
  token: string,
  patientRef: string,
  visitId: string,
): Promise<VisitDTO> {
  const data = await ppmsGet<{ visit: VisitDTO }>(
    token,
    `/api/v1/patients/${encodeURIComponent(patientRef)}/visits/${encodeURIComponent(visitId)}`,
  );
  return data.visit;
}

export async function getAppointments(
  token: string,
  patientRef: string,
  limit = 10,
): Promise<AppointmentDTO[]> {
  const safeLimit = Math.min(Math.max(1, limit), 20);
  const data = await ppmsGet<{ appointments: AppointmentDTO[] }>(
    token,
    `/api/v1/patients/${encodeURIComponent(patientRef)}/appointments?limit=${safeLimit}`,
  );
  return data.appointments;
}

export async function getTimeline(
  token: string,
  patientRef: string,
): Promise<TimelineEventDTO[]> {
  const data = await ppmsGet<{ timeline: TimelineEventDTO[] }>(
    token,
    `/api/v1/patients/${encodeURIComponent(patientRef)}/timeline`,
  );
  return data.timeline;
}
