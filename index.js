// Proxy Relay Server - Scaled for Top 3000 Healthy Proxies (Final Version with Multi-Source Parallel Scraping)
// Features:
// - Dynamic proxy scraping from multiple public sources in parallel (format support: ip:port or protocol://host:port).
// - Only uses healthy proxies (post-health check, top 3000 fastest).
// - Proxy health checks with failover support (axios) - Runs after scraping and periodically.
// - Separate /health endpoint to view/report health status (JSON response with healthy/total counts).
// - Centralized logging with rotation (rotating-file-stream) - All logs public via /logs.
// - Connection pooling for upstream proxies (Map-based with limits and idle timeouts).
// - Usage tracking and metrics (prom-client) exposed at /metrics.
// - Public endpoints for user_proxies.txt and logs (no auth, no pagination).
// - Async I/O for better performance.
// - Error recovery and structured logging.
// - Filters out invalid proxies (https://, socks4://, socks5://).
// Dependencies: npm i proxy-chain socksv5 express axios rotating-file-stream prom-client mkdirp

const ProxyChain = require('proxy-chain');
const socks = require('socksv5');
const fs = require('fs').promises;
const urlModule = require('url');
const net = require('net');
const path = require('path');
const express = require('express');
const axios = require('axios');
const rfs = require('rotating-file-stream');
const client = require('prom-client');
const mkdirp = require('mkdirp');

// Centralized logging with rotation - All logs captured and public
const logDir = path.resolve(__dirname, 'logs');
mkdirp.sync(logDir);
const logStream = rfs.createStream('proxy_logs.txt', {
  interval: '1d', // Rotate daily
  size: '10M',    // Or at 10MB
  compress: 'gzip',
  path: logDir
});

function customLog(level, message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${typeof message === 'object' ? JSON.stringify(message) : message}\n`;
  logStream.write(logEntry);
  console.log(logEntry.trim()); // Also to console
}

// Global variables
let proxyList = [];
let USERS = {};
let activeProxies = new Set(); // Healthy proxies
const usageStats = {}; // { username: { bytesSent, bytesReceived, requests } }
const MAX_PROXIES = 3000; // Limit to top 3000 healthy/fastest proxies
let scrapeFailureCount = 0; // For fallback logic
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min idle timeout for pooled connections

// Multi-source scrape URLs (6 reliable public sources for HTTP proxies)
const SCRAPE_SOURCES = [
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all', // Plain ip:port
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', // Plain ip:port
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt', // Plain ip:port (HTTP subset)
  'https://www.proxy-list.download/api/v1/get?type=http', // Plain ip:port
  'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text&timeout=20000',
  'https://cdn.jsdelivr.net/gh/mzyui/proxy-list@main/all.txt',
 // 'http://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/refs/heads/master/http.txt',
 // 'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/refs/heads/main/proxies/http.txt',
  'https://raw.githubusercontent.com/ErcinDedeoglu/proxies/refs/heads/main/proxies/socks5.txt'
];

// Metrics
const healthyProxiesGauge = new client.Gauge({ name: 'healthy_proxies_total', help: 'Total healthy proxies' });
const scrapedProxiesGauge = new client.Gauge({ name: 'scraped_proxies_total', help: 'Total scraped proxies before health check' });
const totalRequestsCounter = new client.Counter({ name: 'total_requests', help: 'Total proxy requests' });

// Helper to log usage
function logUsage(username, bytesSent, bytesReceived) {
  if (!usageStats[username]) {
    usageStats[username] = { bytesSent: 0, bytesReceived: 0, requests: 0 };
  }
  usageStats[username].bytesSent += bytesSent;
  usageStats[username].bytesReceived += bytesReceived;
  usageStats[username].requests += 1;
  totalRequestsCounter.inc();
}

// Scrape proxies from multiple sources in parallel (supports ip:port and protocol://host:port)
async function scrapeProxies() {
  const scrapePromises = SCRAPE_SOURCES.map(async (scrapeUrl, index) => {
    try {
      customLog('info', `Scraping from source ${index + 1}: ${scrapeUrl}`);
      const response = await axios.get(scrapeUrl, { timeout: 30000 });
      let rawProxies = response.data.trim().split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      // Parse and normalize formats
      const parsedProxies = rawProxies.map(line => {
        if (line.includes('://')) {
          // Full format: protocol://host:port
          const lower = line.toLowerCase();
          if (lower.startsWith('https://') || lower.startsWith('socks4://') || lower.startsWith('socks5://')) {
            return null; // Filter out non-HTTP
          }
          // Validate host/port for http://
          try {
            const parsed = urlModule.parse(line);
            if (net.isIP(parsed.hostname) || parsed.hostname.match(/^[a-zA-Z0-9.-]+$/)) {
              const port = parseInt(parsed.port);
              if (port >= 1 && port <= 65535) {
                return line;
              }
            }
          } catch {}
          return null;
        } else {
          // Plain ip:port -> convert to http://ip:port
          const parts = line.split(':');
          if (parts.length === 2) {
            const host = parts[0];
            const portStr = parts[1];
            if ((net.isIP(host) || host.match(/^[a-zA-Z0-9.-]+$/)) && !isNaN(parseInt(portStr)) && parseInt(portStr) >= 1 && parseInt(portStr) <= 65535) {
              return `http://${line}`;
            }
          }
          return null;
        }
      }).filter(Boolean); // Remove nulls

      customLog('info', `Source ${index + 1} yielded ${parsedProxies.length} valid HTTP proxies`);
      return parsedProxies;
    } catch (err) {
      customLog('warn', `Source ${index + 1} (${scrapeUrl}) failed: ${err.message}`);
      return [];
    }
  });

  const allResults = await Promise.all(scrapePromises);
  const combinedProxies = allResults.flat(); // Combine all

  // Deduplicate (normalize to lowercase for comparison)
  const uniqueProxies = [...new Set(combinedProxies.map(p => p.toLowerCase()))].map(p => combinedProxies.find(proxy => proxy.toLowerCase() === p));

  scrapedProxiesGauge.set(uniqueProxies.length);
  customLog('info', `Combined and deduplicated: ${uniqueProxies.length} unique HTTP proxies from all sources`);

  if (uniqueProxies.length === 0) {
    scrapeFailureCount++;
    return null;
  }

  scrapeFailureCount = 0; // Reset on partial/full success
  return uniqueProxies;
}

// Load proxies (via parallel scraping, with fallback to file)
async function loadProxies() {
  let rawProxies = await scrapeProxies();
  if (!rawProxies || rawProxies.length === 0) {
    if (scrapeFailureCount >= 3) {
      customLog('warn', 'Multiple scrape failures; falling back to proxies.txt permanently');
      try {
        const data = await fs.readFile('proxies.txt', 'utf-8');
        rawProxies = data.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .filter(line => {
            const lower = line.toLowerCase();
            return !lower.startsWith('https://') && !lower.startsWith('socks4://') && !lower.startsWith('socks5://');
          });
        scrapedProxiesGauge.set(rawProxies.length);
      } catch (err) {
        customLog('error', `Fallback file load failed: ${err.message}`);
        process.exit(1);
      }
    } else {
      customLog('warn', 'All scrapes returned no proxies; retrying next cycle');
      return; // Skip this load, retry later
    }
  }

  if (rawProxies.length === 0) {
    customLog('error', 'No valid HTTP proxies found after scraping/file load.');
    process.exit(1);
  }

  proxyList = rawProxies; // Temporarily set full list; will limit after health check
  customLog('info', `Loaded ${proxyList.length} raw proxies; health check will limit to top ${MAX_PROXIES} healthy ones`);
}

// Enhanced health check (batched, tracks response times for sorting top 3000)
async function healthCheck() {
  if (proxyList.length === 0) {
    customLog('warn', 'No proxies loaded, skipping health check');
    return;
  }

  customLog('info', 'Starting health check...');
  const healthResults = []; // { proxyUrl, responseTime, healthy: bool }

  // Batch checks (500 at a time) for performance
  const BATCH_SIZE = 500;
  for (let i = 0; i < proxyList.length; i += BATCH_SIZE) {
    const batch = proxyList.slice(i, i + BATCH_SIZE);
    const checks = batch.map(async (proxyUrl) => {
      const startTime = Date.now();
      try {
        const parsed = urlModule.parse(proxyUrl);
        await axios.get('http://httpbin.org/ip', {
          proxy: { host: parsed.hostname, port: parseInt(parsed.port) || 8080 },
          timeout: 5000
        });
        const responseTime = Date.now() - startTime;
        return { proxyUrl, responseTime, healthy: true };
      } catch (err) {
        customLog('warn', `Health check failed for ${proxyUrl}: ${err.message}`);
        return { proxyUrl, responseTime: Infinity, healthy: false };
      }
    });

    const results = await Promise.allSettled(checks);
    healthResults.push(...results.map(result => result.status === 'fulfilled' ? result.value : null).filter(Boolean));
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between batches
  }

  // Filter healthy and sort by response time (fastest first)
  const healthyProxies = healthResults
    .filter(r => r.healthy)
    .sort((a, b) => a.responseTime - b.responseTime)
    .slice(0, MAX_PROXIES); // Top 3000

  const topHealthyUrls = healthyProxies.map(r => r.proxyUrl);
  activeProxies = new Set(topHealthyUrls);
  proxyList = topHealthyUrls; // Update proxyList to only top healthy

  healthyProxiesGauge.set(activeProxies.size);
  customLog('info', `Health check completed: ${activeProxies.size} healthy (top ${MAX_PROXIES} fastest) out of ${healthResults.length} checked`);

  // Regenerate users based on top healthy proxies only
  USERS = {};
  proxyList.forEach((proxy, index) => {
    const username = `kevin${index + 1}`;
    const password = `pass${index + 1}`;
    USERS[username] = { password, proxyIndex: index };
  });

  await writeUserProxiesFile(); // Update file with only healthy top proxies
}

// Write user proxies file (async, only healthy)
async function writeUserProxiesFile() {
  const lines = [];
  Object.entries(USERS).forEach(([username, { password, proxyIndex }]) => {
    const upstreamProxy = proxyList[proxyIndex];
    if (!upstreamProxy || !activeProxies.has(upstreamProxy)) return; // Skip unhealthy (redundant now, but safe)
    const parsed = urlModule.parse(upstreamProxy);
    const line = `${parsed.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parsed.host}`;
    lines.push(line);
  });
  const filePath = path.resolve(__dirname, 'user_proxies.txt');
  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
  customLog('info', `User  proxy list saved to ${filePath} (${lines.length} entries - top healthy only)`);
}

// Basic upstream proxy connection pool (Map-based, with refCount limits and idle timeout)
const proxyPool = new Map(); // key: `${hostname}:${port}` -> { socket: net.Socket, refCount: number, idleTimer: timeout }

// Get or create pooled connection
function getPooledConnection(proxyUrl, callback) {
  const parsed = urlModule.parse(proxyUrl);
  const key = `${parsed.hostname}:${parsed.port || 8080}`;
  const maxConnections = 50; // Per-proxy limit for scale

  if (proxyPool.has(key)) {
    const entry = proxyPool.get(key);
    if (entry.refCount < maxConnections && entry.socket && !entry.socket.destroyed) {
      // Clear idle timer on use
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      entry.refCount += 1;
      proxyPool.set(key, entry);
      return callback(null, entry.socket);
    } else if (entry.refCount >= maxConnections) {
      return callback(new Error(`Max connections reached for ${key}`));
    } else {
      proxyPool.delete(key);
    }
  }

  const newSocket = net.connect(parsed.port || 8080, parsed.hostname, () => {
    const entry = { 
      socket: newSocket, 
      refCount: 1,
      idleTimer: setTimeout(() => {
        if (entry.refCount === 0 && entry.socket && !entry.socket.destroyed) {
          entry.socket.destroy();
          proxyPool.delete(key);
          customLog('debug', `Idle timeout: closed pooled connection for ${key}`);
        }
      }, IDLE_TIMEOUT)
    };
    proxyPool.set(key, entry);
    callback(null, newSocket);
  });

  newSocket.on('error', (err) => {
    if (proxyPool.has(key)) proxyPool.delete(key);
    customLog('error', `Pooled connection error for ${key}: ${err.message}`);
    callback(err);
  });

  newSocket.on('close', () => {
    if (proxyPool.has(key)) {
      const entry = proxyPool.get(key);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.refCount -= 1;
      if (entry.refCount <= 0) {
        proxyPool.delete(key);
        customLog('debug', `Pooled connection fully closed for ${key}`);
      } else {
        // Restart idle timer if still active
        entry.idleTimer = setTimeout(() => {
          if (entry.refCount === 0 && entry.socket && !entry.socket.destroyed) {
            entry.socket.destroy();
            proxyPool.delete(key);
          }
        }, IDLE_TIMEOUT);
        proxyPool.set(key, entry);
      }
    }
  });
}

// Release connection
function releaseConnection(proxyUrl) {
  const parsed = urlModule.parse(proxyUrl);
  const key = `${parsed.hostname}:${parsed.port || 8080}`;
  if (proxyPool.has(key)) {
    const entry = proxyPool.get(key);
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      proxyPool.delete(key);
    } else {
      // Restart idle timer
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        if (entry.refCount === 0 && entry.socket && !entry.socket.destroyed) {
          entry.socket.destroy();
          proxyPool.delete(key);
        }
      }, IDLE_TIMEOUT);
      proxyPool.set(key, entry);
    }
    customLog('debug', `Released connection for ${key} (refCount: ${entry.refCount})`);
  }
}

// --- HTTP/HTTPS Proxy Server with proxy-chain ---
const httpProxyServer = new ProxyChain.Server({
  port: 8000,

  prepareRequestFunction: ({ username, password, request }) => {
    if (!username || !password) {
      customLog('info', `[HTTP Proxy] Authentication required for request to ${request.url}`);
      return {
        responseCode: 407,
        responseHeaders: { 'Proxy-Authenticate': 'Basic realm="Proxy Relay"' },
        body: 'Proxy authentication required',
      };
    }

    const user = USERS[username];
    if (!user || user.password !== password) {
      customLog('info', `[HTTP Proxy] Invalid credentials for user: ${username}`);
      return {
        responseCode: 403,
        body: 'Invalid username or password',
      };
    }

    let upstreamProxyUrl = proxyList[user.proxyIndex];
    if (!upstreamProxyUrl || !activeProxies.has(upstreamProxyUrl)) {
      // Failover: Find next healthy proxy (only among active/top 3000)
      const healthyList = Array.from(activeProxies);
      let healthyIndex = healthyList.findIndex(p => p === upstreamProxyUrl);
      if (healthyIndex === -1) healthyIndex = -1;
      const nextIndex = (healthyIndex + 1) % healthyList.length;
      upstreamProxyUrl = healthyList[nextIndex] || healthyList[0];
      if (!upstreamProxyUrl) {
        customLog('error', `[HTTP Proxy] No healthy upstream proxy for user: ${username}`);
        return { responseCode: 503, body: 'No healthy proxies available' };
      }
    }

    customLog('info', `[HTTP Proxy] User: ${username} requested ${request.url} via ${upstreamProxyUrl}`);

    return {
      upstreamProxyUrl,
      userInfo: { username, requestUrl: request.url },
    };
  },

  handleRequestFinished: ({ userInfo, bytesRead, bytesWritten }) => {
    if (userInfo && userInfo.username) {
      logUsage(userInfo.username, bytesWritten, bytesRead);
      customLog('info', `[HTTP Proxy] User: ${userInfo.username} - Sent: ${bytesWritten} bytes, Received: ${bytesRead} bytes`);

      customLog('info', {
        type: 'http_traffic',
        user: userInfo.username,
        url: userInfo.requestUrl,
        bytesSent: bytesWritten,
        bytesReceived: bytesRead,
        timestamp: new Date().toISOString()
      });
    }
  },
});

httpProxyServer.listen(() => {
  customLog('info', `HTTP/HTTPS Proxy Relay running on port 8000`);
});

httpProxyServer.on('error', (err) => {
  customLog('error', `HTTP Proxy Server error: ${err.message || err}`);
});

// --- SOCKS4/5 Proxy Server with socksv5 (with pooling and failover) ---
// Improved setup: Use 'connection' event for better control, proper response buffering
const socksServer = socks.createServer();

socksServer.useAuth(socks.auth.UserPassword((user, password, cb) => {
  const userData = USERS[user];
  if (userData && userData.password === password) {
    cb(true, user); // Pass user as user for connection handler
  } else {
    customLog('info', `[SOCKS Auth] Invalid credentials for user: ${user}`);
    cb(false);
  }
}));

socksServer.on('connection', (socket, info) => {
  const user = info.user; // From auth callback (per socksv5 docs)
  if (!user || !USERS[user]) {
    customLog('info', `[SOCKS Proxy] Connection denied: unknown user '${user}'`);
    socket.end();
    return;
  }

  const userData = USERS[user];
  let upstreamProxy = proxyList[userData.proxyIndex];
  if (!upstreamProxy || !activeProxies.has(upstreamProxy)) {
    // Failover: Find next healthy (only among top 3000 active)
    const healthyList = Array.from(activeProxies);
    let healthyIndex = healthyList.findIndex(p => p === upstreamProxy);
    if (healthyIndex === -1) healthyIndex = -1;
    const nextIndex = (healthyIndex + 1) % healthyList.length;
    upstreamProxy = healthyList[nextIndex] || healthyList[0];
    if (!upstreamProxy) {
      customLog('error', `[SOCKS Proxy] No healthy upstream proxy for user: ${user}`);
      socket.end();
      return;
    }
  }

  customLog('info', `[SOCKS Proxy] User: ${user} connecting to ${info.dstAddr}:${info.dstPort} via ${upstreamProxy}`);

  getPooledConnection(upstreamProxy, (err, proxySocket) => {
    if (err) {
      customLog('error', `[SOCKS Proxy] Failed to get pooled connection to ${upstreamProxy}: ${err.message}`);
      socket.end();
      return;
    }

    const connectReq = `CONNECT ${info.dstAddr}:${info.dstPort} HTTP/1.1\r\nHost: ${info.dstAddr}:${info.dstPort}\r\n\r\n`;
    proxySocket.write(connectReq);

    let responseBuffer = Buffer.alloc(0);
    let isConnected = false;
    let bytesSent = (info.head ? info.head.length : 0);
    let bytesReceived = 0;

    const handleData = (chunk) => {
      if (!isConnected) {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        const str = responseBuffer.toString();
        if (str.includes('\r\n\r\n')) {
          if (/^HTTP\/1\.[01] 200/.test(str)) {
            isConnected = true;
            // Skip headers and send remaining data
            const headerEnd = str.indexOf('\r\n\r\n') + 4;
            const remaining = chunk.slice(str.length - chunk.length + headerEnd);
            if (remaining.length > 0) {
              socket.write(remaining);
              bytesReceived += remaining.length;
            }
            if (info.head && info.head.length) {
              proxySocket.write(info.head);
              bytesSent += info.head.length;
            }
            // Pipe streams
            socket.pipe(proxySocket);
            proxySocket.pipe(socket);

            // Track bytes on data events (for logging)
            socket.on('data', (data) => {
              bytesSent += data.length;
              customLog('debug', `[SOCKS Proxy] User: ${user} sent ${data.length} bytes`);
            });

            proxySocket.on('data', (data) => {
              bytesReceived += data.length;
              customLog('debug', `[SOCKS Proxy] User: ${user} received ${data.length} bytes`);
            });

            // Close handler
            const onClose = () => {
              releaseConnection(upstreamProxy);
              logUsage(user, bytesSent, bytesReceived);
              customLog('info', `[SOCKS Proxy] User: ${user} connection closed. Total sent: ${bytesSent} bytes, received: ${bytesReceived} bytes`);

              customLog('info', {
                type: 'socks_traffic',
                user,
                destination: `${info.dstAddr}:${info.dstPort}`,
                bytesSent,
                bytesReceived,
                timestamp: new Date().toISOString()
              });
            };

            socket.on('close', onClose);
            proxySocket.on('close', onClose);

            socket.on('error', (err) => {
              customLog('error', `[SOCKS Proxy] User: ${user} client error: ${err.message || err}`);
              releaseConnection(upstreamProxy);
              proxySocket.end();
            });

            proxySocket.on('error', (err) => {
              customLog('error', `[SOCKS Proxy] User: ${user} upstream error: ${err.message || err}`);
              releaseConnection(upstreamProxy);
              socket.end();
            });

            responseBuffer = Buffer.alloc(0); // Reset
          } else {
            const errorMsg = str.split('\r\n')[0];
            customLog('info', `[SOCKS Proxy] User: ${user} upstream failed: ${errorMsg}`);
            releaseConnection(upstreamProxy);
            socket.end();
            proxySocket.end();
            responseBuffer = Buffer.alloc(0);
          }
        }
      } else {
        // Already connected: forward data
        socket.write(chunk);
        bytesReceived += chunk.length;
      }
    };

    proxySocket.on('data', handleData);

    proxySocket.on('error', (err) => {
      customLog('error', `[SOCKS Proxy] User: ${user} upstream socket error: ${err.message || err}`);
      releaseConnection(upstreamProxy);
      socket.end();
    });

    socket.on('error', (err) => {
      customLog('error', `[SOCKS Proxy] User: ${user} client socket error: ${err.message || err}`);
      releaseConnection(upstreamProxy);
      proxySocket.end();
    });

    // Timeout for CONNECT response
    const connectTimeout = setTimeout(() => {
      if (!isConnected) {
        customLog('warn', `[SOCKS Proxy] User: ${user} CONNECT timeout to ${upstreamProxy}`);
        releaseConnection(upstreamProxy);
        socket.end();
        proxySocket.end();
      }
    }, 10000);

    proxySocket.on('close', () => {
      clearTimeout(connectTimeout);
    });
  });
});

socksServer.listen(1080, '0.0.0.0', () => {
  customLog('info', 'SOCKS4/5 Proxy Relay running on port 1080');
});

socksServer.on('error', (err) => {
  customLog('error', `SOCKS server error: ${err.message || err}`);
});

// --- Express server for public endpoints (no auth, no pagination) ---
const app = express();

app.get('/user_proxies.txt', async (req, res) => {
  const filePath = path.resolve(__dirname, 'user_proxies.txt');
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    res.type('text/plain').send(data || 'No proxies available.');
    customLog('info', `Served full user_proxies.txt to ${req.ip}`);
  } catch (err) {
    customLog('warn', `Access to /user_proxies.txt failed: ${err.message}`);
    res.status(404).send('user_proxies.txt not found');
  }
});

// Public logs at / (tailed for large files)
app.get('/', async (req, res) => {
  // Handle rotated logs: find latest or scan directory
  let logPath;
  try {
    const streamNames = rfs.getStreamNames ? rfs.getStreamNames(logDir, 'proxy_logs.txt') : [];
    const latestLog = streamNames.sort().pop();
    logPath = latestLog ? path.join(logDir, latestLog) : path.join(logDir, 'proxy_logs.txt');
  } catch {
    // Fallback: scan directory for .txt or .gz files
    const files = await fs.readdir(logDir);
    const logFiles = files.filter(f => f.startsWith('proxy_logs') && (f.endsWith('.txt') || f.endsWith('.gz')));
    logPath = logFiles.length > 0 ? path.join(logDir, logFiles.sort().pop()) : path.join(logDir, 'proxy_logs.txt');
  }

  try {
    const data = await fs.readFile(logPath, 'utf-8');
    // Tail last 10k chars for performance with large logs
    const tailed = data.length > 10000 ? data.slice(-10000) : data;
    res.type('text/plain').send(tailed || 'No logs yet.');
    customLog('info', `Served public logs (tailed) to ${req.ip}`);
  } catch (err) {
    res.status(404).send('Logs not found');
    customLog('warn', `Failed to serve logs: ${err.message}`);
  }
});

// Full logs endpoint (full file, for small logs)
app.get('/logs', async (req, res) => {
  // Same logic as above for rotated logs
  let logPath;
  try {
    const streamNames = rfs.getStreamNames ? rfs.getStreamNames(logDir, 'proxy_logs.txt') : [];
    const latestLog = streamNames.sort().pop();
    logPath = latestLog ? path.join(logDir, latestLog) : path.join(logDir, 'proxy_logs.txt');
  } catch {
    const files = await fs.readdir(logDir);
    const logFiles = files.filter(f => f.startsWith('proxy_logs') && (f.endsWith('.txt') || f.endsWith('.gz')));
    logPath = logFiles.length > 0 ? path.join(logDir, logFiles.sort().pop()) : path.join(logDir, 'proxy_logs.txt');
  }

  try {
    const data = await fs.readFile(logPath, 'utf-8');
    res.type('text/plain').send(data || 'No logs yet.');
    customLog('info', `Served full logs to ${req.ip}`);
  } catch (err) {
    res.status(404).send('Logs not found');
    customLog('warn', `Failed to serve full logs: ${err.message}`);
  }
});

// Separate health check endpoint (JSON response, public for monitoring)
app.get('/health', (req, res) => {
  const { details = 'false' } = req.query; // Optional: ?details=true to list healthy proxies
  const healthStatus = {
    totalProxies: proxyList.length, // Now limited to top 3000
    healthyProxies: activeProxies.size,
    healthyPercentage: proxyList.length > 0 ? Math.round((activeProxies.size / proxyList.length) * 100) : 0,
    lastChecked: new Date().toISOString(), // Approximate; could track exact timestamp
    status: activeProxies.size > 0 ? 'healthy' : 'degraded',
    maxProxies: MAX_PROXIES
  };

  if (details === 'true') {
    healthStatus.healthyList = Array.from(activeProxies); // Top 3000 healthy
    healthStatus.scrapedSources = SCRAPE_SOURCES; // For transparency
  }

  res.json(healthStatus);
  customLog('info', `Health status requested by ${req.ip} (details: ${details})`);
});

// Metrics endpoint (public, no auth for monitoring tools)
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.listen(3000, '0.0.0.0', () => {
  customLog('info', 'Public file server running at http://localhost:3000/');
  customLog('info', 'Public logs available at http://localhost:3000/ (tailed)');
  customLog('info', 'Full logs at http://localhost:3000/logs');
  customLog('info', 'Full user_proxies.txt at http://localhost:3000/user_proxies.txt');
  customLog('info', 'Health status at http://localhost:3000/health (JSON, public)');
  customLog('info', 'Metrics at http://localhost:3000/metrics (public)');
});

// --- Initialization and Periodic Tasks ---
// Periodic scraping + health check (no chokidar; dynamic)
async function init() {
  await loadProxies(); // Scrape/load proxies
  if (proxyList.length > 0) {
    customLog('info', 'Proxies loaded, starting initial health check...');
    await healthCheck(); // Limit to top 3000 healthy
  }
  // Periodic health check (every 5 minutes)
  setInterval(healthCheck, 5 * 60 * 1000);
  // Periodic re-scrape (every 10 minutes) to refresh source
  setInterval(async () => {
    customLog('info', 'Periodic scraping starting...');
    await loadProxies();
    if (proxyList.length > 0) {
      await healthCheck(); // Re-check and limit after scrape
    }
  }, 10 * 60 * 1000);
}

init().catch(err => {
  customLog('error', `Initialization failed: ${err.message}`);
  process.exit(1);
});

// --- Handle uncaught exceptions and rejections (all logged publicly) ---
process.on('uncaughtException', (err) => {
  customLog('error', `Uncaught Exception: ${err.stack || err}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  customLog('error', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  customLog('info', 'SIGINT received, shutting down gracefully');
  httpProxyServer.close(() => {});
  socksServer.close(() => {});
  app.close(() => {});
  process.exit(0);
});

process.on('SIGTERM', () => {
  customLog('info', 'SIGTERM received, shutting down gracefully');
  httpProxyServer.close(() => {});
  socksServer.close(() => {});
  app.close(() => {});
  process.exit(0);
});
