export const mockChat = [
  {
    viewer: "Maya",
    message: "Is the serum good for morning routines?",
  },
  {
    viewer: "Jon",
    message: "Can you show the tumbler again?",
  },
  {
    viewer: "Priya",
    message: "Any verified bundle offer today?",
  },
];

export const mockLedgerEvents = [
  {
    id: "evt-001",
    label: "Transcript scanned",
    detail: "Detected possible mention: GlowFix serum",
    status: "complete",
  },
  {
    id: "evt-002",
    label: "SKU selected",
    detail: "Active shelf item set to GlowFix Vitamin C Serum",
    status: "complete",
  },
  {
    id: "evt-003",
    label: "Guardrail ready",
    detail: "Unverified discounts require host confirmation",
    status: "watching",
  },
];

export const mockEvaluations = [
  {
    category: "SKU Grounding",
    passed: 10,
    total: 10,
    summary: "Checks explicit product mentions and active SKU context.",
  },
  {
    category: "Commerce Intent",
    passed: 9,
    total: 10,
    summary: "Checks order and quantity detection for viewer messages.",
  },
  {
    category: "Safety Guardrails",
    passed: 10,
    total: 10,
    summary: "Checks unsupported discounts and risky claims.",
  },
];
