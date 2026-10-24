# ResultShield — Self-Healing University Result Portal

A BCA third-year Identity project demonstrating a student result portal and resilience mechanisms.

## Requirements
- Node.js 18 or newer
- MongoDB Community Server running locally, or a MongoDB Atlas connection string
- PM2 for the automatic process restart demonstration (`npm install -g pm2`)

## Install and run
1. Copy `.env.example` to `.env`.
2. Check `MONGODB_URI` in `.env`.
3. Run `npm install`.
4. Run `npm run seed` to insert demo results.
5. Run `npm start`.
6. Open `http://localhost:3000` for the student portal and `http://localhost:3000/dashboard` for the health dashboard.

Demo roll numbers: `RS2026001`, `RS2026002`, `RS2026003`.

## Self-healing mechanisms
1. MongoDB startup retry with exponential backoff.
2. Retry with exponential backoff for result reads and the simulated external service.
3. Circuit breaker for the simulated external service.
4. Last-known in-memory result cache fallback when the database is unavailable.
5. API rate limiting to protect against request bursts.
6. PM2 process watchdog configured in `ecosystem.config.js`.

## Chaos demo
Use the dashboard's Chaos Lab locally. The chaos endpoints are enabled only when `CHAOS_ENABLED=true` and `NODE_ENV` is not `production`. Do not expose chaos controls to a public production deployment.

Run `npm run chaos` in another terminal for database simulation, external service circuit breaker, and traffic tests. For process restart, run `npm install -g pm2`, then `pm2 start ecosystem.config.js`, open the dashboard and use the crash button. Check `pm2 status` and `pm2 logs resultshield` afterward.

## Important limitations
- Database-down mode in the dashboard is a controlled simulation. Also test a real MongoDB outage by stopping the local MongoDB service; cache fallback only works for records already loaded into memory.
- Cache is in-memory and is cleared when the Node process restarts. A persistent cache (e.g. Redis) is a future improvement.
- The external result service is simulated for safe repeatable testing.
- This is an educational demo. Add authentication, role-based authorization, HTTPS, audit controls, and secure deployment configuration before using real student data.
- Record measured detection and recovery times from actual tests; do not invent performance numbers.

## Architecture
Browser → Express portal → MongoDB results. The health API reports component states. A last-known cache supports degraded reads. A simulated external service demonstrates retries and circuit breaking. PM2 supervises the Node process.
