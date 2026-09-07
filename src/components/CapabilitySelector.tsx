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
];

// Short tab labels for the horizontal bar.
const TAB_LABELS: Partial<Record<Capability, string>> = {
  PATIENT_SNAPSHOT: "Snapshot",
  PREVIOUS_VISIT_SUMMARY: "Previous Visits",
  TIMELINE_SUMMARY: "Timeline",
  IMPORTANT_CHANGES: "Attention",
  NOTE_ASSISTANCE: "Draft Note",
  FOLLOW_UP_SUMMARY: "Follow-up",
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
      className="shrink-0 border-b border-gray-200 bg-white px-3"
    >
      <ul
        className="flex gap-1 overflow-x-auto scrollbar-none py-2"
        role="list"
        style={{ scrollbarWidth: "none" }}
      >
        {MVP_CAPABILITIES.map((cap) => {
          const isActive = cap === active;
          const label = TAB_LABELS[cap] ?? CAPABILITY_CONFIG[cap].label;
          return (
            <li key={cap} className="shrink-0">
              <button
                type="button"
                onClick={() => !disabled && onSelect(cap)}
                aria-current={isActive ? "page" : undefined}
                aria-disabled={disabled}
                disabled={disabled}
                className={[
                  "px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500",
                  isActive
                    ? "bg-teal-600 text-white shadow-sm"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900",
                  disabled && !isActive ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                ].join(" ")}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
