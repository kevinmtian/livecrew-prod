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
