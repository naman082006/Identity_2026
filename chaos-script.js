
const BASE_URL = "http://localhost:3000";

const failures = [
  { name: "Database Failure", type: "database-off" },
  { name: "External Service Failure", type: "external-off" },
  { name: "Traffic Burst", type: "traffic-burst" }
];

async function triggerFailure(failure) {
  console.log(`\n[CHAOS] Testing: ${failure.name}`);

  try {
    const response = await fetch(
      `${BASE_URL}/api/chaos/${failure.type}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }
    );

    const result = await response.text();

    console.log(`HTTP Status: ${response.status}`);
    console.log(`Response: ${result}`);
  } catch (error) {
    console.error(`Failed: ${error.message}`);
  }
}

async function runChaosTests() {
  console.log("ResultShield Chaos Test Started");

  for (const failure of failures) {
    await triggerFailure(failure);
  }

  console.log("\nChaos tests completed.");
  console.log("Check the Health Dashboard for component status.");
}

runChaosTests();
