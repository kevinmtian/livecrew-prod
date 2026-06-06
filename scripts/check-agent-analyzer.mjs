import assert from "node:assert/strict";

import { deterministicAnalyzeViewerMessage } from "../.tmp-agent-check/agent-analyzer.js";

const cases = [
  {
    message: "I want to order another 50",
    activeSkuId: "glowfix-vitamin-c-serum",
    expectedQuantity: 50,
  },
  {
    message: "Please help me order! I want to purchase 150 of it.",
    activeSkuId: "glowfix-vitamin-c-serum",
    expectedQuantity: 150,
  },
  {
    message: "I want to order another hydramist cushion SPF",
    activeSkuId: "glowfix-vitamin-c-serum",
    expectedQuantity: 1,
    expectedSkuId: "hydramist-cushion-spf",
  },
];

for (const testCase of cases) {
  const analysis = deterministicAnalyzeViewerMessage(testCase);

  assert.equal(analysis.intent, "order", testCase.message);
  assert.equal(analysis.orderQuantity, testCase.expectedQuantity, testCase.message);

  if (testCase.expectedSkuId) {
    assert.equal(analysis.skuId, testCase.expectedSkuId, testCase.message);
  }
}

console.log("agent analyzer acceptance checks passed");
