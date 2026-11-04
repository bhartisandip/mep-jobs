// Title-based relevance filter and mepmate.com discipline mapping.
// Only the job title is used; nothing about the job is invented.

export const DEFAULT_INCLUDE = [
  'hvac', 'mep', 'bim', 'revit', 'navisworks', 'plumbing', 'public health', 'drainage',
  'fire fighting', 'firefighting', 'fire protection', 'fire alarm', 'sprinkler', 'fire & safety',
  'electrical', 'mechanical', 'building services', 'ventilation', 'air conditioning', 'chiller', 'elv',
];
export const DEFAULT_EXCLUDE = [
  'software', 'developer', 'embedded', 'firmware', 'pcb', 'automotive', 'data engineer', 'sap', 'salesforce',
  'structural', 'structures', 'architect', 'civil', 'medical equipment',
];

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9&+]+/g, ' ').trim()} `;
// Whole-word / whole-phrase match: both sides are space-padded by norm().
const has = (t, term) => t.includes(norm(term));

export function isRelevant(title, include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE) {
  const t = norm(title);
  if (exclude.some((x) => has(t, x))) return false;
  return include.some((x) => has(t, x));
}

const DESIGN = /\b(design|designer|modell?er|modell?ing|draughts?man|draftsman|drafting|estimation|estimator|bim)\b/;
const SITE = /\b(site|execution|supervisor|installation|commissioning|maintenance|facility|facilities|construction|foreman)\b/;

// Returns one of mepmate.com's discipline values.
export function mapDiscipline(title) {
  const t = String(title || '').toLowerCase();
  const sub = (base) => (DESIGN.test(t) ? `${base} Design` : SITE.test(t) ? `${base} Site` : 'Other');
  if (/\bbim\b|revit|navisworks/.test(t)) return 'BIM';
  if (/fire ?fighting|fire protection|fire alarm|sprinkler|fire & safety|fire and safety/.test(t)) return 'Firefighting';
  if (/hvac|ventilation|air.?condition|chiller|\bmechanical\b/.test(t)) return sub('HVAC');
  if (/plumbing|public health|drainage|\bphe\b/.test(t)) return sub('Plumbing');
  if (/electrical|\belv\b/.test(t)) return sub('Electrical');
  if (/\bmep\b|building services/.test(t)) return 'MEP Coordination';
  return 'Other';
}
