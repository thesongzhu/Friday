import { asString, compact } from "../_shared/friday-runtime-skill-utils.mjs";

const UI_ELEMENTS = [
  { patterns: [/\bnav\b/i, /\bnavigation\b/i, /\bmenu\b/i, /\bsidebar\b/i], element: "navigation", zone: "top-or-left" },
  { patterns: [/\bheader\b/i, /\bbanner\b/i, /\btop\s*bar\b/i], element: "header", zone: "top" },
  { patterns: [/\bfooter\b/i, /\bbottom\b/i], element: "footer", zone: "bottom" },
  { patterns: [/\bform\b/i, /\binput\b/i, /\bfield\b/i, /\btext\s*box\b/i], element: "form", zone: "main" },
  { patterns: [/\bbutton\b/i, /\bcta\b/i, /\baction\b/i], element: "button", zone: "main" },
  { patterns: [/\bcard\b/i, /\btile\b/i], element: "card", zone: "main" },
  { patterns: [/\btable\b/i, /\blist\b/i, /\bgrid\b/i], element: "data-display", zone: "main" },
  { patterns: [/\bmodal\b/i, /\bdialog\b/i, /\bpopup\b/i, /\boverlay\b/i], element: "modal", zone: "overlay" },
  { patterns: [/\bimage\b/i, /\bphoto\b/i, /\bicon\b/i, /\billustration\b/i], element: "media", zone: "main" },
  { patterns: [/\bsearch\b/i, /\bfilter\b/i], element: "search-filter", zone: "top" },
];

const ACCESSIBILITY_CHECKS = [
  { pattern: /\bcolor\b/i, check: "Ensure sufficient color contrast (WCAG AA minimum 4.5:1 for text)." },
  { pattern: /\bfont\b|text\s*size/i, check: "Use minimum 16px body text; ensure scalable font sizes." },
  { pattern: /\bimage\b|\bicon\b/i, check: "Add alt text to all images and meaningful icons." },
  { pattern: /\bform\b|\binput\b|\bfield\b/i, check: "Label all form inputs; use visible focus indicators." },
  { pattern: /\bbutton\b|\bclick\b|\btap\b/i, check: "Ensure minimum 44x44px touch targets; use descriptive button labels." },
  { pattern: /\bmodal\b|\bdialog\b/i, check: "Trap focus inside modals; provide keyboard-accessible close." },
  { pattern: /\btable\b|\bgrid\b/i, check: "Use proper table headers; ensure keyboard navigation for data grids." },
];

const SPACING_RULES = [
  "Use consistent spacing scale (4px, 8px, 16px, 24px, 32px, 48px).",
  "Group related elements with tighter spacing; separate distinct sections with larger gaps.",
  "Maintain minimum 16px padding inside interactive containers.",
];

function detectElements(text) {
  const found = [];
  for (const entry of UI_ELEMENTS) {
    if (entry.patterns.some(p => p.test(text))) {
      found.push({ element: entry.element, zone: entry.zone });
    }
  }
  if (found.length === 0) {
    found.push({ element: "content-block", zone: "main" });
  }
  return found;
}

function buildHierarchy(elements) {
  const zones = { top: [], left: [], main: [], bottom: [], overlay: [] };
  for (const el of elements) {
    const zone = el.zone === "top-or-left" ? "top" : el.zone;
    if (zones[zone]) zones[zone].push(el.element);
    else zones.main.push(el.element);
  }
  return zones;
}

function generateSpacingSuggestions(elements) {
  const suggestions = [...SPACING_RULES];
  if (elements.some(e => e.element === "card")) {
    suggestions.push("Use equal gap between cards (16px or 24px); maintain consistent card heights in rows.");
  }
  if (elements.some(e => e.element === "form")) {
    suggestions.push("Stack form fields vertically with 12-16px gap; place labels above inputs.");
  }
  if (elements.some(e => e.element === "navigation")) {
    suggestions.push("Keep nav items evenly spaced; highlight active state clearly.");
  }
  return suggestions;
}

function checkAccessibility(text) {
  const notes = [];
  for (const check of ACCESSIBILITY_CHECKS) {
    if (check.pattern.test(text)) {
      notes.push(check.check);
    }
  }
  // Always include baseline checks
  notes.push("Ensure keyboard navigability for all interactive elements.");
  notes.push("Test with screen reader; use semantic HTML elements.");
  return [...new Set(notes)];
}

function suggestLayout(elements) {
  const hasNav = elements.some(e => e.element === "navigation");
  const hasCards = elements.some(e => e.element === "card");
  const hasTable = elements.some(e => e.element === "data-display");
  const hasForm = elements.some(e => e.element === "form");

  if (hasNav && hasTable) return "sidebar-nav with data table main area (dashboard pattern)";
  if (hasNav && hasCards) return "sidebar-nav with card grid main area";
  if (hasForm) return "centered single-column form layout with clear section breaks";
  if (hasCards) return "responsive card grid (auto-fill, min 280px per card)";
  return "single-column centered content layout";
}

export async function execute(input = {}) {
  const layout = asString(input.layout ?? input.content ?? input.text);
  if (!layout) {
    throw new Error("ui-ux-layout-advisor requires a layout input.");
  }

  const elements = detectElements(layout);
  const hierarchy = buildHierarchy(elements);
  const spacingSuggestions = generateSpacingSuggestions(elements);
  const accessibilityNotes = checkAccessibility(layout);
  const layoutSuggestion = suggestLayout(elements);

  return {
    summary: `Layout analysis: ${elements.length} UI elements detected. Suggested pattern: ${compact(layoutSuggestion, 80)}.`,
    nextStep: "Apply the hierarchy, spacing, and accessibility suggestions to your design.",
    details: {
      suggestedLayout: layoutSuggestion,
      detectedElements: elements,
      hierarchy,
      spacingSuggestions,
      accessibilityNotes,
      elementCount: elements.length,
      suggestedSkillId: "infographic-builder",
    },
  };
}
