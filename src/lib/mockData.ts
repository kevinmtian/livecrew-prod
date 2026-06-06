export type RouteKey = "host" | "viewer" | "agent";

export const liveSession = {
  title: "LiveCrew Launch Room",
  host: "Maya Chen",
  runtime: "42:18",
  status: "Live",
  audience: 1834,
  conversionRate: "8.7%",
  revenue: "$18,420",
  orders: 286,
};

export const chatMessages = [
  {
    id: "msg-1",
    user: "nina88",
    text: "Can I use GlowFix under the cushion SPF?",
    intent: "Product detail",
    priority: "High",
  },
  {
    id: "msg-2",
    user: "samuel.k",
    text: "How long does the tumbler keep drinks cold?",
    intent: "Safety",
    priority: "Medium",
  },
  {
    id: "msg-3",
    user: "lina_live",
    text: "Add the sleep mask to the bundle please",
    intent: "Cart action",
    priority: "Low",
  },
];

export const runOfShow = [
  {
    time: "00:40",
    label: "Open GlowFix serum demo",
    owner: "Host",
    state: "Done",
  },
  {
    time: "05:00",
    label: "SPF layering objection handling",
    owner: "Agent",
    state: "Now",
  },
  {
    time: "08:30",
    label: "Tumbler and sleep mask bundle",
    owner: "Host",
    state: "Next",
  },
];

export const agentEvaluations = [
  {
    id: "eval-1",
    agent: "FAQ Copilot",
    score: 94,
    result: "Pass",
    note: "Answered warranty questions with current mock policy.",
  },
  {
    id: "eval-2",
    agent: "Offer Guard",
    score: 87,
    result: "Review",
    note: "Flagged expired discount copy before host prompt.",
  },
  {
    id: "eval-3",
    agent: "Cart Assistant",
    score: 91,
    result: "Pass",
    note: "Mapped viewer bundle requests to the active product set.",
  },
];

export const viewerActions = [
  { label: "Product clicks", value: "612", change: "+12%" },
  { label: "Cart adds", value: "348", change: "+9%" },
  { label: "Checkout starts", value: "211", change: "+6%" },
];
