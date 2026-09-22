"use client";

import type { Capability } from "@/types/client";
import { CAPABILITY_CONFIG } from "@/capabilities";

const MVP_CAPABILITIES: Capability[] = [
  "PATIENT_SNAPSHOT",
  "PREVIOUS_VISIT_SUMMARY",
  "TIMELINE_SUMMARY",
  "IMPORTANT_CHANGES",
  "NOTE_ASSISTANCE",
  "FOLLOW_UP_SUMMARY",
  "DIFFERENTIAL_DIAGNOSIS",
  "MEDICATIONS_SUMMARY",
  "INVESTIGATIONS_SUMMARY",
  "ASSESSMENT_CONTEXT",
  "SUGGESTED_QUESTIONS",
  "PLAN_GUIDANCE",
  "INVESTIGATION_GUIDANCE",
  "DIAGNOSIS_COMPARISON",
  "LAST_VISIT_SUMMARY",
];

// Short tab labels — kept concise for horizontal nav at narrow widths.
const TAB_LABELS: Partial<Record<Capability, string>> = {
  PATIENT_SNAPSHOT:       "Snapshot",
  PREVIOUS_VISIT_SUMMARY: "Prev. Visits",
  TIMELINE_SUMMARY:       "Timeline",
  IMPORTANT_CHANGES:      "Attention",
  NOTE_ASSISTANCE:        "Draft Note",
  FOLLOW_UP_SUMMARY:      "Follow-up",
  DIFFERENTIAL_DIAGNOSIS: "Differential Dx",
  MEDICATIONS_SUMMARY:    "Medications",
  INVESTIGATIONS_SUMMARY: "Investigations",
  ASSESSMENT_CONTEXT:     "Assessment",
  SUGGESTED_QUESTIONS:    "Doc Gaps",
  PLAN_GUIDANCE:          "Plan Guidance",
  INVESTIGATION_GUIDANCE: "Investigation Guidance",
  DIAGNOSIS_COMPARISON: "Plausibility",
  LAST_VISIT_SUMMARY: "Last Visit",
};

interface CapabilitySelectorProps {
  active: Capability;
  onSelect: (cap: Capability) => void;
  disabled: boolean;
}

export function CapabilitySelector({ active, onSelect, disabled }: CapabilitySelectorProps) {
  return (
    <nav
      aria-label="AI capabilities"
      className="shrink-0 bg-white"
      style={{ borderBottom: "1px solid #e2e8f0" }}
    >
      <ul
        role="tablist"
        className="flex overflow-x-auto"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" } as React.CSSProperties}
      >
        {MVP_CAPABILITIES.map(cap => {
          const isActive = cap === active;
          const label = TAB_LABELS[cap] ?? CAPABILITY_CONFIG[cap].label;

          return (
            <li key={cap} role="none" className="shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-disabled={disabled}
                disabled={disabled}
                onClick={() => !disabled && onSelect(cap)}
                className={[
                  "relative flex items-center whitespace-nowrap px-3 py-2.5",
                  "text-[11.5px] font-medium transition-colors duration-150",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-teal-400",
                  isActive
                    ? "text-teal-700"
                    : disabled
                      ? "text-slate-400 cursor-not-allowed"
                      : "text-slate-500 hover:text-slate-700 hover:bg-slate-50 cursor-pointer",
                ].join(" ")}
              >
                {label}

                {/* Active underline indicator */}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-0 right-0 bg-teal-600"
                    style={{ height: "2px", borderRadius: "2px 2px 0 0" }}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
