"use client";

import type { Capability } from "@/types/client";
import { CAPABILITY_CONFIG } from "@/capabilities";

// Phase 3 MVP: 6 capabilities. QUESTION and HISTORY_SUMMARY are Phase 4.
const MVP_CAPABILITIES: Capability[] = [
  "PATIENT_SNAPSHOT",
  "PREVIOUS_VISIT_SUMMARY",
  "TIMELINE_SUMMARY",
  "IMPORTANT_CHANGES",
  "NOTE_ASSISTANCE",
  "FOLLOW_UP_SUMMARY",
];

// Simple inline SVG icons — no external CDN required.
function Icon({ name }: { name: string }) {
  const icons: Record<string, React.ReactNode> = {
    snapshot: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
    ),
    previous: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    ),
    timeline: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z"
      />
    ),
    changes: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
      />
    ),
    note: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
      />
    ),
    followup: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"
      />
    ),
  };

  const capToIcon: Record<Capability, string> = {
    PATIENT_SNAPSHOT: "snapshot",
    PREVIOUS_VISIT_SUMMARY: "previous",
    HISTORY_SUMMARY: "timeline",
    TIMELINE_SUMMARY: "timeline",
    IMPORTANT_CHANGES: "changes",
    NOTE_ASSISTANCE: "note",
    FOLLOW_UP_SUMMARY: "followup",
    QUESTION: "snapshot",
  };

  const iconKey = capToIcon[name as Capability] ?? "snapshot";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className="w-4 h-4 shrink-0"
      aria-hidden="true"
    >
      {icons[iconKey]}
    </svg>
  );
}

interface CapabilitySelectorProps {
  active: Capability;
  onSelect: (cap: Capability) => void;
  disabled: boolean;
}

export function CapabilitySelector({ active, onSelect, disabled }: CapabilitySelectorProps) {
  return (
    <nav
      aria-label="AI capabilities"
      className="w-56 shrink-0 bg-slate-800 flex flex-col overflow-y-auto"
    >
      <div className="px-3 pt-4 pb-2">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wider px-2">
          Capabilities
        </p>
      </div>
      <ul className="flex-1 px-2 pb-4 space-y-0.5" role="list">
        {MVP_CAPABILITIES.map((cap) => {
          const config = CAPABILITY_CONFIG[cap];
          const isActive = cap === active;
          return (
            <li key={cap}>
              <button
                type="button"
                onClick={() => !disabled && onSelect(cap)}
                aria-current={isActive ? "page" : undefined}
                aria-disabled={disabled}
                disabled={disabled}
                className={[
                  "w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors",
                  "flex items-start gap-2.5",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400",
                  isActive
                    ? "bg-slate-700 text-white border-l-2 border-teal-400 pl-[10px]"
                    : "text-slate-300 hover:bg-slate-700 hover:text-white border-l-2 border-transparent pl-[10px]",
                  disabled && !isActive ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                ].join(" ")}
              >
                <span className={`mt-0.5 ${isActive ? "text-teal-400" : "text-slate-400"}`}>
                  <Icon name={cap} />
                </span>
                <span className="leading-snug">{config.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
