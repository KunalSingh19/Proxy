// Proxy Relay Server - HTTP/HTTPS (proxy-chain), SOCKS4/5 (socksv5), and public download of user_proxies.txt
// Optimizations:
// - Improved connection handling in SOCKS proxy: Added connection reuse logic (basic pooling for upstream proxies) to reduce overhead for multiple connections.
// - Centralized logging to a file ('proxy_logs.txt') for persistence and public serving.
// - Public logs endpoint at '/' on port 3000 (serves the log file as plain text).
// - All logs (info, error, debug, etc.) are now fully public via http://<server-ip>:3000/ (bound to 0.0.0.0 for accessibility).
// - Minor efficiency: Reduced redundant parsing, added error boundaries, and streamlined usage tracking.

const ProxyChain = require('proxy-chain');
const socks = require('socksv5');
const fs = require('fs');
const url = require('url');
const net = require('net');
const path = require('path');
const express = require('express');

// Centralized logging to file (replaces custom logger) - All logs are captured here
const logFile = path.resolve(__dirname, 'proxy_logs.txt');
function customLog(level, message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${typeof message === 'object' ? JSON.stringify(message) : message}\n`;
  try {
    fs.appendFileSync(logFile, logEntry);
  } catch (err) {
    // Fallback to console if file write fails
    console.error(`[FALLBACK LOG] ${logEntry.trim()}`);
  }
  // Always log to console for real-time monitoring
  console.log(logEntry.trim());
}

// Load proxies from file (no auth), filter out https and socks4 proxies
const proxyList = fs.readFileSync('proxies.txt', 'utf-8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.length > 0)
  .filter(line => {
    const lower = line.toLowerCase();
    return !lower.startsWith('https://') && !lower.startsWith('socks4://');
  });

if (proxyList.length === 0) {
  customLog('error', 'No valid HTTP proxies found in proxies.txt after filtering out https and socks4 proxies.');
  process.exit(1);
}

// Dynamically generate USERS object based on proxies
const USERS = {};
proxyList.forEach((proxy, index) => {
  const username = `kevin${index + 1}`;
  const password = `pass${index + 1}`;
  USERS[username] = { password, proxyIndex: index };
});

customLog('info', `Generated USERS: ${JSON.stringify(USERS)}`);

// Usage tracking object
const usageStats = {}; // { username: { bytesSent, bytesReceived, requests } }

// Helper to log usage
function logUsage(username, bytesSent, bytesReceived) {
  if (!usageStats[username]) {
    usageStats[username] = { bytesSent: 0, bytesReceived: 0, requests: 0 };
  }
  usageStats[username].bytesSent += bytesSent;
  usageStats[username].bytesReceived += bytesReceived;
  usageStats[username].requests += 1;
  // Log usage stats periodically or on demand if needed (all logs are captured via customLog)
}

// Basic upstream proxy connection pool (for optimization: reuse connections where possible)
const proxyPool = new Map(); // proxyUrl -> { socket: net.Socket, refCount: number }

// Get or create pooled connection for upstream proxy
function getPooledConnection(proxyUrl, callback) {
  const parsed = url.parse(proxyUrl);
  const key = `${parsed.hostname}:${parsed.port}`;
  if (proxyPool.has(key)) {
    const { socket, refCount } = proxyPool.get(key);
    if (socket && !socket.destroyed) {
      proxyPool.set(key, { socket, refCount: refCount + 1 });
      return callback(null, socket);
    } else {
      proxyPool.delete(key);
    }
  }

  const newSocket = net.connect(parsed.port || 8080, parsed.hostname, () => {
    const pooled = { socket: newSocket, refCount: 1 };
    proxyPool.set(key, pooled);
    callback(null, newSocket);
  });

  newSocket.on('error', (err) => {
    proxyPool.delete(key);
    customLog('error', `Pooled connection error for ${key}: ${err.message}`);
    callback(err);
  });

  newSocket.on('close', () => {
    if (proxyPool.has(key)) {
      const { refCount } = proxyPool.get(key);
      if (refCount <= 1) {
        proxyPool.delete(key);
        customLog('debug', `Pooled connection closed for ${key} (refCount reached 0)`);
      } else {
        proxyPool.set(key, { socket: null, refCount: refCount - 1 });
      }
    }
  });
}

// Release connection (decrement refCount)
function releaseConnection(proxyUrl) {
  const parsed = url.parse(proxyUrl);
  const key = `${parsed.hostname}:${parsed.port}`;
  if (proxyPool.has(key)) {
    const { refCount } = proxyPool.get(key);
    if (refCount > 1) {
      proxyPool.set(key, { socket: proxyPool.get(key).socket, refCount: refCount - 1 });
      customLog('debug', `Released connection for ${key} (new refCount: ${refCount - 1})`);
    } else {
      proxyPool.delete(key);
      customLog('debug', `Fully released pooled connection for ${key}`);
    }
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
        responseHeaders: {
          'Proxy-Authenticate': 'Basic realm="Proxy Relay"',
        },
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

    const upstreamProxyUrl = proxyList[user.proxyIndex];
    if (!upstreamProxyUrl) {
      customLog('error', `[HTTP Proxy] No upstream proxy assigned for user: ${username}`);
      return {
        responseCode: 500,
        body: 'No upstream proxy assigned',
      };
    }

    customLog('info', `[HTTP Proxy] User: ${username} requested ${request.url}`);

    return {
      upstreamProxyUrl,
      userInfo: { username, requestUrl: request.url },
    };
  },

  handleRequestFinished: ({ userInfo, bytesRead, bytesWritten }) => {
    if (userInfo && userInfo.username) {
      logUsage(userInfo.username, bytesWritten, bytesRead);
      customLog('info', `[HTTP Proxy] User: ${userInfo.username} - Sent: ${bytesWritten} bytes, Received: ${bytesRead} bytes`);

      // Traffic log (structured) - All details captured
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
  customLog('info', `HTTP/HTTPS Proxy Relay running on port ${httpProxyServer.port}`);
});

httpProxyServer.on('error', (err) => {
  customLog('error', `HTTP Proxy Server error: ${err.message || err}`);
});

// --- SOCKS4/5 Proxy Server with socksv5 (optimized with connection pooling) ---
const socksServer = socks.createServer((info, accept, deny) => {
  // Deny here because we handle connection in 'proxyConnect' event
  deny();
});

socksServer.useAuth(socks.auth.UserPassword((user, password, cb) => {
  const userData = USERS[user];
  if (userData && userData.password === password) {
    cb(true);
  } else {
    customLog('info', `[SOCKS Auth] Invalid credentials for user: ${user}`);
    cb(false);
  }
}));

socksServer.on('proxyConnect', (info, destination, socket, head) => {
  const user = info.userId;
  if (!user || !USERS[user]) {
    customLog('info', `[SOCKS Proxy] Connection denied: unknown user '${user}'`);
    socket.end();
    return;
  }

  const userData = USERS[user];
  const upstreamProxy = proxyList[userData.proxyIndex];
  if (!upstreamProxy) {
    customLog('error', `[SOCKS Proxy] No upstream proxy assigned for user: ${user}`);
    socket.end();
    return;
  }

  customLog('info', `[SOCKS Proxy] User: ${user} connecting to ${info.dstAddr}:${info.dstPort} via upstream proxy ${upstreamProxy}`);

  const parsedProxy = url.parse(upstreamProxy);

  getPooledConnection(upstreamProxy, (err, proxySocket) => {
    if (err) {
      customLog('error', `[SOCKS Proxy] Failed to connect to upstream proxy ${upstreamProxy}: ${err.message}`);
      socket.end();
      return;
    }

    const connectReq = `CONNECT ${info.dstAddr}:${info.dstPort} HTTP/1.1\r\nHost: ${info.dstAddr}:${info.dstPort}\r\n\r\n`;
    proxySocket.write(connectReq);

    proxySocket.once('data', (chunk) => {
      const response = chunk.toString();
      if (/^HTTP\/1\.[01] 200/.test(response)) {
        // Forward the 200 response to client
        if (head && head.length) {
          socket.write(head);
        }
        socket.write(chunk);

        // Bidirectional pipe with optimized data tracking
        const pipeStream = proxySocket.pipe(socket);
        socket.pipe(proxySocket);

        let bytesSent = head ? head.length : 0;
        let bytesReceived = chunk.length;

        socket.on('data', (data) => {
          bytesSent += data.length;
          customLog('debug', `[SOCKS Proxy] User: ${user} sent ${data.length} bytes`);
        });

        proxySocket.on('data', (data) => {
          bytesReceived += data.length;
          customLog('debug', `[SOCKS Proxy] User: ${user} received ${data.length} bytes`);
        });

        const onClose = () => {
          releaseConnection(upstreamProxy); // Release from pool
          logUsage(user, bytesSent, bytesReceived);
          customLog('info', `[SOCKS Proxy] User: ${user} connection closed. Total sent: ${bytesSent} bytes, received: ${bytesReceived} bytes`);

          // Traffic log (structured) - All details captured
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
          customLog('error', `[SOCKS Proxy] User: ${user} client socket error: ${err.message || err}`);
          releaseConnection(upstreamProxy);
          proxySocket.end();
        });

        proxySocket.on('error', (err) => {
          customLog('error', `[SOCKS Proxy] User: ${user} upstream proxy socket error: ${err.message || err}`);
          releaseConnection(upstreamProxy);
          socket.end();
        });
      } else {
        customLog('info', `[SOCKS Proxy] User: ${user} upstream proxy connection failed with response: ${response.split('\r\n')[0]}`);
        releaseConnection(upstreamProxy);
        socket.end();
        proxySocket.end();
      }
    });

    proxySocket.on('error', (err) => {
      customLog('error', `[SOCKS Proxy] User: ${user} upstream proxy socket error: ${err.message || err}`);
      releaseConnection(upstreamProxy);
      socket.end();
    });

    socket.on('error', (err) => {
      customLog('error', `[SOCKS Proxy] User: ${user} client socket error: ${err.message || err}`);
      releaseConnection(upstreamProxy);
      proxySocket.end();
    });
  });
});

socksServer.listen(1080, '0.0.0.0', () => {
  customLog('info', 'SOCKS4/5 Proxy Relay running on port 1080');
  writeUserProxiesFile();
});

socksServer.on('error', (err) => {
  customLog('error', `SOCKS server error: ${err.message || err}`);
});

// --- Write user proxies file ---
function writeUserProxiesFile() {
  const lines = [];
  Object.entries(USERS).forEach(([username, { password, proxyIndex }]) => {
    const upstreamProxy = proxyList[proxyIndex];
    if (!upstreamProxy) return;
    // Parse upstream proxy URL to extract protocol and host:port
    const parsed = url.parse(upstreamProxy);
    // Compose line: protocol://username:password@host:port
    const line = `${parsed.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parsed.host}`;
    lines.push(line);
  });
  const filePath = path.resolve(__dirname, 'user_proxies.txt');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  customLog('info', `User  proxy list saved to ${filePath}`);
}

// --- Express server to serve user_proxies.txt and public logs at / (bound to 0.0.0.0 for public access) ---
const app = express();
app.get('/user_proxies.txt', (req, res) => {
  const filePath = path.resolve(__dirname, 'user_proxies.txt');
  // Check if file exists
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      customLog('warn', `Access to /user_proxies.txt failed: file not found`);
      res.status(404).send('user_proxies.txt not found');
    } else {
      res.sendFile(filePath);
      customLog('info', `Served user_proxies.txt to ${req.ip}`);
    }
  });
});

// Public logs endpoint at root "/" - Serves all logs as plain text (publicly accessible)
app.get('/', (req, res) => {
  // Ensure log file exists
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, '');
  }
  const logsContent = fs.readFileSync(logFile, 'utf-8');
  res.type('text/plain').send(logsContent || 'No logs yet.');
  customLog('info', `Served public logs to ${req.ip}`);
});

// Optional: Serve logs with tail (last N lines) for large files - but keeping it simple as full file
app.get('/logs', (req, res) => {
  // Ensure log file exists
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, '');
  }
  const logsContent = fs.readFileSync(logFile, 'utf-8');
  res.type('text/plain').send(logsContent || 'No logs yet.');
  customLog('info', `Served public logs (alt endpoint) to ${req.ip}`);
});

app.listen(3000, '0.0.0.0', () => {
  customLog('info', 'Public file server running at http://<server-ip>:3000/user_proxies.txt');
  customLog('info', 'Public logs available at http://<server-ip>:3000/ (all logs are public)');
  customLog('info', 'Alternative logs endpoint: http://<server-ip>:3000/logs');
});

app.on('error', (err) => {
  customLog('error', `Express server error: ${err.message || err}`);
});

// --- Handle uncaught exceptions and rejections (all logged publicly) ---
process.on('uncaughtException', (err) => {
  customLog('error', `Uncaught Exception: ${err.stack || err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  customLog('error', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
});
