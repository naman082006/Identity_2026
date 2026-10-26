# 🛡️ ResultShield — Self-Healing Software

**When Systems Fail, Results Stay Available.**

ResultShield is a self-healing software system designed to detect failures, monitor system health, and recover from simulated errors to keep student results accessible.

## ✨ Key Features

- 🎓 Student Result Search
- 📊 Real-Time System Health Dashboard
- 🔍 Failure Detection and Diagnosis
- 🔄 Manual Healing and System Recovery
- 🗄️ Database Failure Simulation
- 🌐 External Service Failure Detection
- ⚡ Traffic Burst and Rate Limiting
- 🔐 Admin Panel for Result Management
- 📋 Incident Logs and Recovery Tracking

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** MongoDB, Mongoose
- **Frontend:** HTML, CSS, JavaScript, EJS
- **Process Management:** PM2

## 🚀 Getting Started

```bash
git clone https://github.com/naman082006/Identity_2026.git
cd resultshield
npm install
node server.js
```

Configure your `.env` file and ensure MongoDB is running before starting the application.

## 🌐 Application Pages

- Student Portal: `http://localhost:3000`
- Health Dashboard: `http://localhost:3000/dashboard`
- Admin Login: `http://localhost:3000/admin/login`

## 🎯 Project Objective

To demonstrate fault detection, chaos testing, system monitoring, and recovery mechanisms for building more reliable software applications.

## 👨‍💻 Developed By

**Naman Jain & Tanish Yadav**

Academic Project | Self-Healing Software System

---

⭐ **ResultShield — Detect. Recover. Stay Available.**



## Chaos Testing

ResultShield includes a Chaos Testing script to simulate system failures and check how the application responds.

### Failure Scenarios

1. **Database Failure (`database-off`)** — Simulates database unavailability.
2. **External Service Failure (`external-off`)** — Simulates an external service failure.
3. **Traffic Burst (`traffic-burst`)** — Activates a simulated application outage.

### How to Run

Make sure the ResultShield application is running before starting the tests.

Open the terminal in the `resultshield` folder and run:

```bash
node chaos-script.js
```

The script sends requests to the chaos API endpoints and displays the HTTP status and response for each test.

### Recovery Verification

1. Open the Health Dashboard at `http://localhost:3000/dashboard`.
2. Observe the component statuses after the failures are triggered.
3. Use the available restore controls to recover the simulated failures.
4. Verify that the components return to a healthy state.

**Note:** Run chaos tests only in your local development environment because they can make the application temporarily unavailable.
