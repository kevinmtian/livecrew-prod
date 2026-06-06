import assert from "node:assert/strict";

import { runAgentEvaluationSuite } from "../.tmp-agent-check/agent-eval-suite.js";

const result = runAgentEvaluationSuite();

assert.ok(result.total >= 60, "suite must include at least 60 cases");
assert.equal(result.failed, 0, "current suite must pass before UI work");

for (const category of result.categories) {
  assert.ok(
    category.total >= 10,
    `${category.name} must include at least 10 cases`,
  );
}

console.log(
  `agent eval suite passed: ${result.passed}/${result.total} (${result.passRate}%)`,
);
