// Proxy Relay Server - Ultra-Fast Startup for Render.com (Fixed Route Path)
// Features:
// - Instant server start (<2s); proxies loaded async after.
// - No health check on startup; delayed/batched periodic checks only.
// - HTTP Proxy Relay via Express + lightweight axios forwarding.
// - /metrics with healthy relayed proxies list (comments).
// - Env-based; console logs only.
// Dependencies: Same as before.

const url = require('url');
const express = require('express');
const axios = require('axios');
const client = require('prom-client');

// Console logging (minimal for speed)
function customLog(level, message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${typeof message === 'object' ? JSON.stringify(message) : message}`;
  console.log(logEntry);
}

// Globals
let proxyList = [];
let USERS = {};
let activeProxies = new Set();
const usageStats = {};
let isInitialized = false;

// Metrics
const healthyProxiesGauge = new client.Gauge({ name: 'healthy_proxies_total', help: 'Total healthy upstream proxies' });
const totalRequestsCounter = new client.Counter({ name: 'total_requests', help: 'Total proxy requests' });

// Env config
const HEALTH_CHECK_ENABLED = process.env.HEALTH_CHECK_ENABLED !== 'false';
const SKIP_INITIAL_HEALTH = process.env.SKIP_INITIAL_HEALTH !== 'false';
const BATCH_SIZE = parseInt(process.env.HEALTH_CHECK_BATCH_SIZE) || 100;
const INITIAL_HEALTH_DELAY = parseInt(process.env.INITIAL_HEALTH_DELAY) || 30000; // 30s

// Log usage
function logUsage(username, bytesSent, bytesReceived) {
  if (!usageStats[username]) {
    usageStats[username] = { bytesSent: 0, bytesReceived: 0, requests: 0 };
  }
  usageStats[username].bytesSent += bytesSent;
  usageStats[username].bytesReceived += bytesReceived;
  usageStats[username].requests += 1;
  totalRequestsCounter.inc();
}

// Generate healthy relayed proxies list
function getHealthyRelayedProxiesList() {
  const lines = [];
  Object.entries(USERS).forEach(([username, { password, proxyIndex }]) => {
    const upstreamProxy = proxyList[proxyIndex];
    if (!upstreamProxy || !activeProxies.has(upstreamProxy)) return;
    const parsed = url.parse(upstreamProxy);
    const line = `${parsed.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parsed.host}`;
    lines.push(line);
  });
  return lines;
}

// Load proxies (fast env parse)
async function loadProxies() {
  try {
    const proxiesEnv = process.env.PROXIES_LIST || '';
    if (!proxiesEnv) {
      customLog('warn', 'No PROXIES_LIST; no proxies loaded.');
      return;
    }

    proxyList = proxiesEnv.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .filter(line => {
        const lower = line.toLowerCase();
        return !lower.startsWith('https://') && !lower.startsWith('socks4://');
      });

    if (proxyList.length === 0) {
      customLog('warn', 'No valid proxies in PROXIES_LIST.');
      return;
    }

    USERS = {};
    proxyList.forEach((proxy, index) => {
      const username = `kevin${index + 1}`;
      const password = `pass${index + 1}`;
      USERS[username] = { password, proxyIndex: index };
    });

    activeProxies = new Set(proxyList); // All healthy initially
    healthyProxiesGauge.set(proxyList.length);

    customLog('info', `Loaded ${proxyList.length} proxies, ${Object.keys(USERS).length} users.`);
  } catch (err) {
    customLog('error', `Load proxies failed: ${err.message}`);
  }
}

// Fast batched health check (no logs per proxy)
async function healthCheck() {
  if (!HEALTH_CHECK_ENABLED || proxyList.length === 0) {
    return;
  }

  customLog('info', `Batched health check starting (${BATCH_SIZE}/batch)...`);
  const healthy = new Set();
  const batches = [];
  for (let i = 0; i < proxyList.length; i += BATCH_SIZE) {
    batches.push(proxyList.slice(i, i + BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const checks = batch.map(async (proxyUrl) => {
      try {
        const parsed = url.parse(proxyUrl);
        await axios.get('http://httpbin.org/ip', {
          proxy: { host: parsed.hostname, port: parsed.port || 8080 },
          timeout: 2000  // 2s for ultra-speed
        });
        return proxyUrl;
      } catch {
        return null; // Silent fail
      }
    });

    const results = await Promise.allSettled(checks);
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        healthy.add(result.value);
      }
    });

    if (b < batches.length - 1) {
      await new Promise(r => setTimeout(r, 100)); // Quick batch delay
    }
  }

  activeProxies = healthy;
  healthyProxiesGauge.set(healthy.size);
  customLog('info', `Health check done: ${healthy.size}/${proxyList.length} healthy.`);
}

// --- Express App ---
const app = express();
app.use(express.json());

// Instant ready endpoint
app.get('/ready', (req, res) => {
  res.json({ status: 'ready', initialized: isInitialized, healthy: activeProxies.size });
});

// User proxies endpoint
app.get('/user_proxies', (req, res) => {
  const format = req.query.format || 'text';
  const list = getHealthyRelayedProxiesList();
  if (format === 'json') {
    res.json({ proxies: list, count: list.length, time: new Date().toISOString() });
  } else {
    res.type('text/plain').send(list.join('\n') || 'No healthy proxies.');
  }
  customLog('info', `User  proxies served (${format}): ${list.length}`);
});

// Health endpoint
app.get('/health', (req, res) => {
  const details = req.query.details === 'true';
  const status = {
    total: proxyList.length,
    healthy: activeProxies.size,
    percentage: proxyList.length > 0 ? Math.round((activeProxies.size / proxyList.length) * 100) : 0,
    time: new Date().toISOString(),
    status: activeProxies.size > 0 ? 'healthy' : 'degraded',
    initialized: isInitialized
  };
  if (details) {
    status.healthyList = Array.from(activeProxies);
    status.unhealthyList = proxyList.filter(p => !activeProxies.has(p));
  }
  res.json(status);
  customLog('info', `Health requested (details: ${details})`);
});

// Metrics with relayed list
app.get('/metrics', async (req, res) => {
  const metrics = await client.register.metrics();
  const list = getHealthyRelayedProxiesList();
  let comment = `# No healthy relayed proxies (as of ${new Date().toISOString()})\n\n`;
  if (list.length > 0) {
    comment = `# Healthy Relayed Proxies List (user-facing, ${new Date().toISOString()}):\n${list.map(line => `# ${line}`).join('\n')}\n\n`;
  }
  res.set('Content-Type', client.register.contentType);
  res.end(`${comment}${metrics}`);
  customLog('info', 'Metrics served');
});

// Auth middleware for proxy (prefix /proxy)
app.use('/proxy', (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('Proxy-Authenticate', 'Basic realm="Proxy Relay"');
    return res.status(407).send('Auth required');
  }
  const creds = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const [username, password] = creds;
  const user = USERS[username];
  if (!user || user.password !== password) {
    return res.status(403).send('Invalid creds');
  }
  req.proxyUser  = { username, userIndex: user.proxyIndex };
  next();
});

// Proxy forwarder (fixed route: /proxy/:target* for catch-all)
app.all('/proxy/:target*', async (req, res) => {
  const { username, userIndex } = req.proxyUser ;
  if (!username) return res.status(401).send('Unauthorized');

  let upstream = proxyList[userIndex];
  if (!upstream || !activeProxies.has(upstream)) {
    const healthyList = Array.from(activeProxies);
    let idx = healthyList.findIndex(p => p === upstream);
    if (idx === -1) idx = -1;
    const nextIdx = (idx + 1) % healthyList.length;
    upstream = healthyList[nextIdx] || healthyList[0];
    if (!upstream) return res.status(503).send('No healthy proxies');
  }

  customLog('info', `[Proxy] ${username} -> ${req.originalUrl} via ${upstream}`);

  try {
    const parsed = url.parse(upstream);
    const target = req.originalUrl.replace('/proxy', ''); // Full target from original URL
    const proxyReq = await axios({
      method: req.method,
      url: target,
      proxy: {
        host: parsed.hostname,
        port: parsed.port || 8080,
        protocol: parsed.protocol.replace(':', '') // e.g., 'http'
      },
      headers: req.headers,
      data: req.body,
      timeout: 30000,
      responseType: 'arraybuffer'
    });

    const bytesSent = req.body ? Buffer.byteLength(req.body) : 0;
    const bytesRecv = proxyReq.data ? proxyReq.data.length : 0;
    logUsage(username, bytesSent, bytesRecv);

    res.status(proxyReq.status);
    Object.entries(proxyReq.headers).forEach(([k, v]) => res.set(k, v));
    res.send(proxyReq.data);
  } catch (err) {
    customLog('error', `[Proxy] ${username} failed: ${err.message}`);
    res.status(502).send('Upstream error');
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    status: 'Proxy Relay Live',
    healthy: activeProxies.size,
    initialized: isInitialized,
    endpoints: {
      health: '/health',
      metrics: '/metrics',
      userProxies: '/user_proxies?format=json',
      proxy: '/proxy/<url> (Basic Auth)'
    }
  });
});

// START SERVER FIRST - Zero Delay
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  customLog('info', `Server on ${PORT} - Instant Ready!`);
});

// Async Init After Start
setImmediate(async () => {
  try {
    await loadProxies();
    isInitialized = true;
    customLog('info', 'Init done (proxies ready).');

    if (HEALTH_CHECK_ENABLED && !SKIP_INITIAL_HEALTH) {
      setTimeout(healthCheck, INITIAL_HEALTH_DELAY);
    }
    if (HEALTH_CHECK_ENABLED) {
      setInterval(healthCheck, 5 * 60 * 1000); // 5min periodic
    }
  } catch (err) {
    customLog('error', `Init error: ${err.message}`);
  }
});

// Shutdown
process.on('SIGTERM', () => {
  customLog('info', 'Shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
