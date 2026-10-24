const BASE = process.env.BASE_URL || 'http://localhost:3000';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  let data = {};
  try { data = await response.json(); } catch {}
  console.log(`${response.status} ${path}`, JSON.stringify(data));
  return { response, data };
}
(async () => {
  console.log(`ResultShield chaos test target: ${BASE}`);
  console.log('\n1) Warm the cache by requesting a demo result.');
  const warm = await fetch(`${BASE}/result`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'rollNumber=RS2026001', redirect: 'manual' });
  console.log('Warm cache result request status:', warm.status, '(302/200 expected depending on route response)');
  await call('/api/chaos/database-on', { method: 'POST' });
  console.log('\n2) Check cached fallback by submitting the same roll number in browser: http://localhost:3000');
  await call('/api/health');
  await call('/api/chaos/database-off', { method: 'POST' });
  console.log('\n3) Inject external timeout, then call service repeatedly to open circuit.');
  await call('/api/chaos/external-on', { method: 'POST' });
  for (let i = 0; i < 4; i++) { await call('/api/external-check'); await wait(200); }
  console.log('\n4) Restore external service and wait for circuit reset window.');
  await call('/api/chaos/external-off', { method: 'POST' });
  await wait(8500);
  await call('/api/external-check');
  console.log('\n5) Send a controlled traffic burst.');
  const started = Date.now();
  const traffic = await Promise.all(Array.from({ length: 80 }, () => fetch(`${BASE}/api/chaos/traffic`)));
  const limited = traffic.filter(r => r.status === 429).length;
  console.log(`80 requests completed in ${Date.now() - started}ms; HTTP 429 responses: ${limited}.`);
  console.log('\nDone. Open /dashboard to inspect incident logs and recovery counts. Crash test is manual: start with PM2, then click the crash button in the dashboard.');
})().catch(error => { console.error(error); process.exit(1); });
