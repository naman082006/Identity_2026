require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const Result = require('./models/Result');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/resultshield';

const CHAOS_ENABLED =
  process.env.CHAOS_ENABLED === 'true' &&
  process.env.NODE_ENV !== 'production';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'resultshield-local-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const state = {
  startedAt: Date.now(),
  applicationDown: false,
  databaseDown: false,
  externalServiceDown: false,
  resultLoadingHang: false,
  externalCircuitOpen: false,
  externalFailures: 0,
  circuitOpenedAt: 0,
  incidents: [],
  recoveries: 0,
  lastError: null,
  requestCount: 0,
  rateLimitEvents: 0,
  autoFailureActive: false,
  autoFailureType: null,
  autoFailureRollNumber: null,
  autoHealingUntil: null,
  autoFailureCount: 0
};

const resultCache = new Map();
const MAX_INCIDENTS = 100;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 8000;

function logIncident(component, status, message, extra = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    time: new Date().toISOString(),
    component,
    status,
    message,
    ...extra
  };

  state.incidents.unshift(entry);
  if (state.incidents.length > MAX_INCIDENTS) state.incidents.pop();

  console.log(JSON.stringify({
    level: status === 'Recovered' ? 'info' : 'warn',
    ...entry
  }));

  if (status === 'Recovered') state.recoveries++;
  return entry;
}

async function connectWithRetry() {
  let delay = 1000;

  while (true) {
    try {
      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(MONGODB_URI, {
          serverSelectionTimeoutMS: 3000
        });
      }

      state.lastError = null;
      logIncident('database', 'Recovered', 'MongoDB connection established');
      return;
    } catch (error) {
      state.lastError = error.message;
      logIncident('database', 'Detected', `MongoDB connection failed: ${error.message}`);
      logIncident('database', 'Diagnosed', 'Connection unavailable; retrying with exponential backoff');

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000);
    }
  }
}

mongoose.connection.on('disconnected', () => {
  state.lastError = 'MongoDB disconnected';
  logIncident('database', 'Detected', 'MongoDB connection lost');
});

mongoose.connection.on('reconnected', () => {
  state.lastError = null;
  logIncident('database', 'Recovered', 'MongoDB reconnected');
});

/*
 * Controlled outage:
 * Keep the dashboard, health API and recovery endpoints available.
 * Block the Student Portal and normal application routes during the outage.
 */
app.use((req, res, next) => {
  if (!state.applicationDown) return next();

  const allowedDuringOutage =
    req.path === '/dashboard' ||
    req.path === '/api/health' ||
    req.path === '/api/chaos/traffic-restore' ||
    req.path === '/api/admin/restore-system';

  if (allowedDuringOutage) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(503).json({
      success: false,
      applicationDown: true,
      message: 'APPLICATION DOWN: Traffic Burst failure is active. Open the Health Dashboard and click Restore Application.'
    });
  }

  return res.status(503).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>ResultShield | Application Unavailable</title>
      <style>
        body{margin:0;min-height:100vh;display:grid;place-items:center;background:#071b15;color:#f5f0df;font-family:Arial,sans-serif}
        main{max-width:520px;margin:24px;padding:36px;border:1px solid #345346;border-radius:20px;background:#102820;text-align:center}
        h1{color:#ff9292}
        p{line-height:1.7;color:#c0d0c4}
        a{display:inline-block;margin-top:14px;padding:12px 18px;border-radius:9px;background:#e7c66b;color:#14251b;text-decoration:none;font-weight:bold}
      </style>
    </head>
    <body>
      <main>
        <h1>APPLICATION DOWN</h1>
        <p>ResultShield is experiencing a simulated traffic outage.</p>
        <p>The recovery console is still available. Restore the application from the Health Dashboard.</p>
        <a href="/dashboard">Open Health Dashboard</a>
      </main>
    </body>
    </html>
  `);
});

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,

  // Keep recovery and chaos controls accessible during traffic tests.
  skip: (req) =>
    req.path === '/health' ||
    req.path.startsWith('/chaos/') ||
    req.path === '/admin/restore-system',

  handler: (req, res) => {
    state.rateLimitEvents++;

    logIncident(
      'traffic',
      'Detected',
      'Rate limit reached; request rejected to protect the app'
    );

    res.status(429).json({
      success: false,
      error: 'Too many requests. Please wait a moment and try again.',
      healing: 'Traffic protection active'
    });
  }
}));

app.use((req, res, next) => {
  state.requestCount++;
  next();
});

async function retry(operation, label, attempts = 3) {
  let delay = 250;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts) throw error;

      logIncident(label, 'Diagnosed', `Attempt ${attempt} failed; retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

function calculateResult(result) {
  const marks = result.marks || {};
  const subjects = [
    'computerNetworks',
    'database',
    'webDevelopment',
    'java',
    'softwareEngineering'
  ];

  const values = subjects.map(subject => {
    const value = Number(marks[subject]);
    return Number.isFinite(value) ? value : 0;
  });

  const total = values.reduce((sum, value) => sum + value, 0);
  const max = subjects.length * 100;
  const percentage = Number(((total / max) * 100).toFixed(2));

  const grade =
    percentage >= 90 ? 'A+' :
    percentage >= 80 ? 'A' :
    percentage >= 70 ? 'B' :
    percentage >= 60 ? 'C' :
    percentage >= 40 ? 'D' : 'F';

  return {
    ...result,
    total,
    max,
    percentage,
    grade,
    pass: values.every(value => value >= 33)
  };
}

function cacheResult(result) {
  if (!result || !result.rollNumber) return;

  const data = typeof result.toObject === 'function'
    ? result.toObject()
    : { ...result };

  resultCache.set(String(result.rollNumber).trim().toUpperCase(), {
    data,
    cachedAt: new Date().toISOString()
  });
}

function clearResultCache(reason) {
  const count = resultCache.size;
  resultCache.clear();

  logIncident(
    'result-cache',
    'Action taken',
    `Cleared ${count} cached result(s). ${reason}`
  );
}

function removeCachedResult(rollNumber) {
  resultCache.delete(String(rollNumber || '').trim().toUpperCase());
}

function databaseUnavailable() {
  return state.databaseDown || mongoose.connection.readyState !== 1;
}

function validateMarks(body) {
  const source = body.marks && typeof body.marks === 'object'
    ? body.marks
    : body;

  const subjects = [
    'computerNetworks',
    'database',
    'webDevelopment',
    'java',
    'softwareEngineering'
  ];

  const marks = {};

  for (const subject of subjects) {
    const rawValue = source[subject];

    if (
      rawValue === undefined ||
      rawValue === null ||
      String(rawValue).trim() === ''
    ) return null;

    const value = Number(rawValue);

    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return null;
    }

    marks[subject] = value;
  }

  return marks;
}

function validateStudent(body) {
  const rollNumber = String(body.rollNumber || '').trim().toUpperCase();
  const studentName = String(body.studentName || '').trim();
  const course = String(body.course || 'BCA').trim();
  const semester = String(body.semester || 'Semester 5').trim();
  const marks = validateMarks(body);

  if (!rollNumber || !studentName || !course || !semester) {
    return { error: 'Please fill all required fields.' };
  }

  if (!marks) {
    return { error: 'Marks must be valid numbers between 0 and 100.' };
  }

  return {
    value: {
      rollNumber,
      studentName,
      course,
      semester,
      marks,
      updatedAt: new Date()
    }
  };
}

async function callExternalService() {
  if (state.externalCircuitOpen) {
    if (Date.now() - state.circuitOpenedAt < CIRCUIT_RESET_MS) {
      throw new Error('Circuit is open; fail-fast protection active');
    }

    state.externalCircuitOpen = false;
    state.externalFailures = 0;
    logIncident('external-service', 'Action taken', 'Circuit breaker reset; testing service again');
  }

  if (state.externalServiceDown) {
    throw new Error('External service unavailable');
  }

  return {
    status: 'ok',
    message: 'External result service is responding'
  };
}

async function getResult(rollNumber) {
  const key = String(rollNumber || '').trim().toUpperCase();
  if (!key) return null;

  if (state.applicationDown) throw new Error('APPLICATION_DOWN');
  if (state.resultLoadingHang) throw new Error('RESULT_LOADING_HANG');
  if (databaseUnavailable()) throw new Error('DATABASE_FAILURE');

  try {
    await retry(() => callExternalService(), 'external-service', 2);

    const result = await retry(
      () => Result.findOne({ rollNumber: key }).lean(),
      'database',
      2
    );

    if (!result) return null;

    cacheResult(result);
    return calculateResult(result);
  } catch (error) {
    state.lastError = error.message;

    if (/external|circuit/i.test(error.message)) {
      throw new Error('EXTERNAL_SERVICE_FAILURE');
    }

    throw new Error('DATABASE_FAILURE');
  }
}

app.get('/', (req, res) => {
  res.render('index', {
    error: null,
    result: null,
    rollNumber: '',
    failureName: null,
    healRequired: false,
    loadingHang: false,
    autoRetryAllowed: false
  });
});

app.post('/result', async (req, res) => {
  const rollNumber = String(req.body.rollNumber || '').trim().toUpperCase();

  if (!rollNumber) return res.redirect('/');

  const renderFailure = (failureName, message) => res.status(503).render('index', {
    error: message,
    result: null,
    rollNumber,
    failureName,
    healRequired: true,
    loadingHang: failureName === 'result-loading',
    autoRetryAllowed: false
  });

  if (state.resultLoadingHang) {
    return renderFailure('result-loading', 'Result loading has failed. Click Heal System to recover.');
  }

  if (databaseUnavailable()) {
    return renderFailure('database', 'Database failure detected. Click Heal System to recover.');
  }

  if (state.externalServiceDown || state.externalCircuitOpen) {
    return renderFailure('external-service', 'External service failure detected. Click Heal System to recover.');
  }

  try {
    const result = await getResult(rollNumber);

    if (!result) {
      return res.status(404).render('index', {
        error: 'Result not found. Please check your roll number.',
        result: null,
        rollNumber,
        failureName: null,
        healRequired: false,
        loadingHang: false,
        autoRetryAllowed: false
      });
    }

    return res.render('index', {
      error: null,
      result,
      rollNumber,
      failureName: null,
      healRequired: false,
      loadingHang: false,
      autoRetryAllowed: false
    });
  } catch (error) {
    state.lastError = error.message;

    const failureName = error.message === 'RESULT_LOADING_HANG'
      ? 'result-loading'
      : error.message === 'EXTERNAL_SERVICE_FAILURE'
        ? 'external-service'
        : 'database';

    return renderFailure(failureName, 'A system failure was detected. Click Heal System to recover.');
  }
});

app.get('/dashboard', (req, res) => res.render('dashboard'));

app.get('/api/result-loading-status', (req, res) => {
  res.json({
    loadingHang: state.resultLoadingHang,
    chaosEnabled: CHAOS_ENABLED
  });
});

app.get('/auto-healing-status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  const rollNumber = String(req.query.rollNumber || '').trim().toUpperCase();
  const failureActive = state.autoFailureActive && state.autoFailureRollNumber === rollNumber;

  res.json({
    enabled: false,
    failureActive,
    failureType: failureActive ? state.autoFailureType : null,
    healingInProgress: false,
    healingEndsAt: null,
    failureCount: state.autoFailureCount,
    message: failureActive ? 'Failure detected. Manual recovery required.' : 'System operational'
  });
});

async function restoreSimulatedFailures() {
  state.applicationDown = false;
  state.databaseDown = false;
  state.externalServiceDown = false;
  state.resultLoadingHang = false;
  state.externalCircuitOpen = false;
  state.externalFailures = 0;
  state.circuitOpenedAt = 0;
  state.autoFailureActive = false;
  state.autoFailureType = null;
  state.autoFailureRollNumber = null;
  state.autoHealingUntil = null;

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  }

  state.lastError = null;
}

app.post('/api/heal-result', async (req, res) => {
  const rollNumber = String(req.body.rollNumber || '').trim().toUpperCase();

  if (!rollNumber) {
    return res.status(400).json({ success: false, message: 'Roll number is required.' });
  }

  try {
    logIncident('application', 'Detected', `Manual healing requested for ${rollNumber}`);
    logIncident('application', 'Diagnosed', 'Manual recovery requested from Student Portal');

    state.resultLoadingHang = false;
    state.externalServiceDown = false;
    state.externalCircuitOpen = false;
    state.externalFailures = 0;
    state.circuitOpenedAt = 0;
    state.databaseDown = false;
    state.autoFailureActive = false;
    state.autoFailureType = null;
    state.autoFailureRollNumber = null;
    state.autoHealingUntil = null;

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    }

    const result = await Result.findOne({ rollNumber }).lean();

    if (!result) {
      return res.status(404).json({ success: false, message: 'Result not found. Please check the roll number.' });
    }

    cacheResult(result);
    state.lastError = null;

    logIncident('application', 'Action taken', 'Manual healing completed; latest result fetched from MongoDB');
    logIncident('application', 'Recovered', `Manual recovery successful for ${rollNumber}`);

    return res.json({
      success: true,
      message: 'Recovery successful. Latest result is ready.',
      result: calculateResult(result)
    });
  } catch (error) {
    state.lastError = error.message;
    logIncident('application', 'Detected', `Manual recovery failed: ${error.message}`);

    return res.status(503).json({
      success: false,
      message: 'Recovery failed. Check MongoDB connection and try again.'
    });
  }
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      success: false,
      message: 'Please login as admin first'
    });
  }

  return res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    return res.status(500).render('admin-login', {
      error: 'Admin credentials are not configured.'
    });
  }

  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).render('admin-login', { error: 'Invalid username or password.' });
  }

  req.session.regenerate(err => {
    if (err) {
      return res.status(500).render('admin-login', { error: 'Login failed. Please try again.' });
    }

    req.session.isAdmin = true;

    req.session.save(saveErr => {
      if (saveErr) {
        return res.status(500).render('admin-login', { error: 'Could not save login session.' });
      }

      res.redirect('/admin');
    });
  });
});

app.get('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});

app.get('/admin', requireAdmin, (req, res) => res.render('admin'));

app.get('/admin/add-result', requireAdmin, (req, res) => res.render('add-result'));

app.get('/admin/edit-result/:id', requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).send('Invalid student result ID.');
    }

    const result = await Result.findById(req.params.id).lean();

    if (!result) return res.status(404).send('Student result not found.');

    return res.render('edit-result', { result });
  } catch (error) {
    console.error('Edit result error:', error.message);
    return res.status(500).send('Unable to open edit page.');
  }
});

/* This endpoint remains reachable during the controlled outage. */
app.post('/api/admin/restore-system', requireAdmin, async (req, res) => {
  try {
    logIncident('application', 'Detected', 'Manual system recovery requested');
    logIncident('application', 'Diagnosed', 'Restoring simulated failure flags and checking MongoDB');

    await restoreSimulatedFailures();
    clearResultCache('System restored; old cached results discarded');

    const studentCount = await Result.countDocuments();

    logIncident('application', 'Action taken', 'Failure flags cleared and database connection checked');
    logIncident('application', 'Recovered', 'System restored successfully from admin recovery control');

    return res.json({
      success: true,
      message: 'System restored successfully.',
      studentCount
    });
  } catch (error) {
    state.lastError = error.message;

    return res.status(503).json({
      success: false,
      message: 'Recovery failed. Check the MongoDB connection and try again.'
    });
  }
});

app.get('/api/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1 && !state.databaseDown;

  const components = [
    {
      name: 'Application',
      status: state.applicationDown ? 'down' : 'healthy',
      detail: state.applicationDown ? 'Controlled traffic outage active' : 'Express server is responding'
    },
    {
      name: 'MongoDB',
      status: dbConnected ? 'healthy' : 'degraded',
      detail: dbConnected ? 'Connected' : 'Unavailable or simulated failure'
    },
    {
      name: 'Result Cache',
      status: resultCache.size ? 'healthy' : 'degraded',
      detail: `${resultCache.size} result(s) cached`
    },
    {
      name: 'External Result Service',
      status: state.externalCircuitOpen ? 'degraded' : state.externalServiceDown ? 'down' : 'healthy',
      detail: state.externalCircuitOpen ? 'Circuit open; calls paused' : state.externalServiceDown ? 'Simulated timeout active' : 'Responding normally'
    },
    {
      name: 'Traffic Guard',
      status: 'healthy',
      detail: `${state.rateLimitEvents} rate-limit event(s) recorded`
    },
    {
      name: 'Manual Recovery',
      status: state.applicationDown || state.databaseDown || state.externalServiceDown || state.resultLoadingHang ? 'degraded' : 'healthy',
      detail: state.applicationDown || state.databaseDown || state.externalServiceDown || state.resultLoadingHang ? 'Failure active; waiting for recovery' : 'Ready for manual recovery'
    }
  ];

  const degraded = components.some(component => component.status !== 'healthy');

  res.set('Cache-Control', 'no-store');
  res.json({
    overall: degraded ? 'degraded' : 'healthy',
    status: state.applicationDown ? 'APPLICATION DOWN' : degraded ? 'DEGRADED' : 'HEALTHY',
    applicationDown: state.applicationDown,
    uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    components,
    incidents: state.incidents.slice(0, 30),
    recoveries: state.recoveries,
    requestCount: state.requestCount,
    cacheEntries: resultCache.size,
    databaseDown: state.databaseDown,
    externalServiceDown: state.externalServiceDown,
    externalCircuitOpen: state.externalCircuitOpen,
    resultLoadingHang: state.resultLoadingHang,
    rateLimitEvents: state.rateLimitEvents,
    lastError: state.lastError,
    autoFailureActive: state.autoFailureActive,
    autoFailureType: state.autoFailureType,
    autoFailureCount: state.autoFailureCount
  });
});

app.get('/api/external-check', async (req, res) => {
  try {
    const response = await retry(callExternalService, 'external-service', 2);
    state.externalFailures = 0;

    if (state.externalCircuitOpen) {
      state.externalCircuitOpen = false;
      logIncident('external-service', 'Recovered', 'Circuit breaker closed after successful test');
    }

    return res.json(response);
  } catch (error) {
    state.externalFailures++;
    logIncident('external-service', 'Detected', error.message);
    logIncident('external-service', 'Diagnosed', `Failure count ${state.externalFailures}/${CIRCUIT_FAILURE_THRESHOLD}`);

    if (state.externalFailures >= CIRCUIT_FAILURE_THRESHOLD && !state.externalCircuitOpen) {
      state.externalCircuitOpen = true;
      state.circuitOpenedAt = Date.now();
      logIncident('external-service', 'Action taken', `Circuit opened for ${CIRCUIT_RESET_MS / 1000} seconds`);
    }

    return res.status(503).json({
      error: error.message,
      circuitOpen: state.externalCircuitOpen
    });
  }
});

app.post('/api/chaos/:type', async (req, res) => {
  if (!CHAOS_ENABLED) {
    return res.status(403).json({
      error: 'Chaos testing is disabled. Set CHAOS_ENABLED=true in local development.'
    });
  }

  const { type } = req.params;

  if (type === 'traffic-restore') {
    state.applicationDown = false;
    logIncident('application', 'Action taken', 'Traffic outage manually cleared');
    logIncident('application', 'Recovered', 'Application restored from Health Dashboard');

    return res.json({
      success: true,
      applicationDown: false,
      message: 'Application restored successfully. Student Portal is available again.'
    });
  }

  if (type === 'traffic-burst') {
    if (state.applicationDown) {
      return res.json({
        success: true,
        applicationDown: true,
        message: 'Application outage is already active.'
      });
    }

    state.applicationDown = true;
    logIncident('traffic', 'Detected', 'Traffic Burst test injected: application made unavailable');
    logIncident('traffic', 'Diagnosed', 'Controlled outage enabled; recovery console remains available');
    logIncident('traffic', 'Action taken', 'Student Portal and Admin Panel requests are blocked');

    return res.json({
      success: true,
      applicationDown: true,
      message: 'Traffic Burst simulated outage activated. Use Restore Application to recover.'
    });
  }

  if (type === 'database-on') {
    state.databaseDown = true;
    clearResultCache('Database failure active; cached fallback disabled');
    logIncident('database', 'Detected', 'Chaos test injected: database reads disabled');
    logIncident('database', 'Diagnosed', 'Result lookups now require database access');
  } else if (type === 'database-off') {
    state.databaseDown = false;
    logIncident('database', 'Recovered', 'Database failure simulation removed manually');
  } else if (type === 'external-on') {
    state.externalServiceDown = true;
    state.externalFailures = 0;
    state.externalCircuitOpen = false;
    state.circuitOpenedAt = 0;
    logIncident('external-service', 'Detected', 'Chaos test injected: external service timeout');
    logIncident('external-service', 'Diagnosed', 'External service failure enabled; manual recovery required');
  } else if (type === 'external-off') {
    state.externalServiceDown = false;
    state.externalCircuitOpen = false;
    state.externalFailures = 0;
    state.circuitOpenedAt = 0;
    logIncident('external-service', 'Recovered', 'External service restored manually');
  } else if (type === 'result-hang-on') {
    state.resultLoadingHang = true;
    logIncident('application', 'Detected', 'Chaos test injected: result loading is stuck');
    logIncident('application', 'Diagnosed', 'Student result requests are blocked until manual healing');
  } else if (type === 'result-hang-off') {
    state.resultLoadingHang = false;
    logIncident('application', 'Recovered', 'Result loading failure removed manually');
  } else if (type === 'crash') {
    logIncident('application', 'Detected', 'Real process crash requested; PM2 should restart it');

    res.json({
      message: 'Node.js process will exit shortly. PM2 must be running with autorestart enabled.'
    });

    setTimeout(() => process.exit(1), 300);
    return;
  } else {
    return res.status(400).json({ error: 'Unknown chaos type' });
  }

  return res.json({ success: true, ok: true, type, message: `Chaos action ${type} applied` });
});

app.get('/api/chaos/traffic', (req, res) => {
  if (!CHAOS_ENABLED) return res.status(403).json({ error: 'Chaos testing disabled' });

  logIncident('traffic', 'Detected', 'Traffic test endpoint hit; API rate limiter is active');

  return res.json({
    message: 'Traffic test endpoint responded',
    requestCount: state.requestCount
  });
});

/* ADD RESULT */

app.post('/api/admin/results', requireAdmin, async (req, res) => {
  try {
    if (databaseUnavailable()) {
      return res.status(503).json({ success: false, message: 'Database is unavailable.' });
    }

    const validated = validateStudent(req.body);
    if (validated.error) {
      return res.status(400).json({ success: false, message: validated.error });
    }

    const existing = await Result.findOne({ rollNumber: validated.value.rollNumber });
    if (existing) {
      return res.status(409).json({ success: false, message: 'This roll number already exists.' });
    }

    const result = await Result.create(validated.value);
    cacheResult(result);
    logIncident('database', 'Healthy', `Admin added result for ${result.rollNumber}`);

    return res.status(201).json({
      success: true,
      message: 'Result added successfully.',
      result
    });
  } catch (error) {
    console.error('Add result error:', error.message);
    return res.status(error.code === 11000 ? 409 : 500).json({
      success: false,
      message: error.code === 11000 ? 'This roll number already exists.' : 'Unable to add result.'
    });
  }
});

/* FETCH ALL RESULTS */

app.get('/api/admin/results', requireAdmin, async (req, res) => {
  try {
    if (databaseUnavailable()) {
      return res.status(503).json({ success: false, message: 'Database is unavailable.' });
    }

    const results = await Result.find().sort({ rollNumber: 1 }).lean();
    results.forEach(cacheResult);

    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    console.error('Fetch results error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to fetch results.' });
  }
});

/* UPDATE RESULT */

app.put('/api/admin/results/:id', requireAdmin, async (req, res) => {
  try {
    if (databaseUnavailable()) {
      return res.status(503).json({ success: false, message: 'Database is unavailable.' });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid result ID.' });
    }

    const validated = validateStudent(req.body);
    if (validated.error) {
      return res.status(400).json({ success: false, message: validated.error });
    }

    const current = await Result.findById(req.params.id).lean();
    if (!current) {
      return res.status(404).json({ success: false, message: 'Result not found.' });
    }

    const duplicate = await Result.findOne({
      rollNumber: validated.value.rollNumber,
      _id: { $ne: req.params.id }
    }).lean();

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'Another student already uses this roll number.'
      });
    }

    const updated = await Result.findByIdAndUpdate(
      req.params.id,
      { $set: validated.value },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Result not found.' });
    }

    removeCachedResult(current.rollNumber);
    cacheResult(updated);

    logIncident('database', 'Healthy', `Admin updated result for ${updated.rollNumber}`);

    return res.json({
      success: true,
      message: 'Result updated successfully.',
      result: updated
    });
  } catch (error) {
    console.error('Update result error:', error.message);
    return res.status(error.code === 11000 ? 409 : 500).json({
      success: false,
      message: error.code === 11000
        ? 'Another student already uses this roll number.'
        : 'Unable to update result.'
    });
  }
});

/* DELETE RESULT */

app.delete('/api/admin/results/:id', requireAdmin, async (req, res) => {
  try {
    if (databaseUnavailable()) {
      return res.status(503).json({ success: false, message: 'Database is unavailable.' });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid result ID.' });
    }

    const deleted = await Result.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Result not found.' });
    }

    removeCachedResult(deleted.rollNumber);
    logIncident('database', 'Healthy', `Admin deleted result for ${deleted.rollNumber}`);

    return res.json({ success: true, message: 'Result deleted successfully.' });
  } catch (error) {
    console.error('Delete result error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to delete result.' });
  }
});

app.get('/api/admin/seed-status', requireAdmin, (req, res) => {
  res.json({
    success: true,
    databaseConnected: mongoose.connection.readyState === 1,
    chaosEnabled: CHAOS_ENABLED,
    message: 'Use your existing seed script to add demo results.'
  });
});

app.listen(PORT, () => {
  console.log(`ResultShield running at http://localhost:${PORT}`);
  console.log(`Health dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`Chaos testing enabled: ${CHAOS_ENABLED}`);
  connectWithRetry();
});
