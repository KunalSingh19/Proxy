const http = require('http');
const url = require('url');
const crypto = require('crypto'); // For base64 decoding in auth

const PROXY_PORT = process.env.PORT || 8080; // Render uses PORT env var
const PROXY_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'; // Render domain or fallback
const TIMEOUT = 10000; // 10s timeout for requests

// In-memory storage for 100 users' credentials (generated on startup for speed)
const userCredentials = new Map();
function generateUsers() {
  const users = [];
  for (let i = 1; i <= 100; i++) {
    const firstNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Jack'];
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
    const first = firstNames[Math.floor(Math.random() * firstNames.length)];
    const last = lastNames[Math.floor(Math.random() * lastNames.length)];
    const fullName = `${first} ${last}`;
    const email = `${fullName.toLowerCase().replace(' ', '.')}@example.com`;
    const age = Math.floor(Math.random() * 48) + 18; // 18-65
    const username = `user${i}`;
    const password = `pass${i}`;
    
    // Store credentials for auth validation
    userCredentials.set(username, password);
    
    users.push({
      id: i,
      name: fullName,
      email: email,
      age: age,
      username: username,
      password: password
    });
  }
  return users;
}

// Generate users on startup (pre-populates credentials)
generateUsers();

// Function to validate basic proxy auth
function validateProxyAuth(req) {
  const authHeader = req.headers['proxy-authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  
  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
  const [username, password] = credentials.split(':');
  
  return userCredentials.has(username) && userCredentials.get(username) === password;
}

// Create the HTTP-only proxy server
const server = http.createServer((req, res) => {
  // Handle special /users endpoint (direct plain text response, no proxying, no auth)
  if (req.url === '/users' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    const users = generateUsers(); // Regenerate for freshness (or use pre-generated)
    const output = users.map(user => 
      `http://${user.username}:${user.password}@${PROXY_HOST}` // No port in URL (Render uses 443/80 externally)
    ).join('\n');
    res.end(output + '\n'); // One line per user, with trailing newline
    return;
  }

  // Require proxy auth for all proxy requests
  if (!validateProxyAuth(req)) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="Proxy Access"',
      'Content-Type': 'text/plain'
    });
    res.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\nProvide valid credentials.');
    return;
  }

  // Only support HTTP methods for HTTP URLs (proxying)
  if (req.method === 'CONNECT') {
    // Reject HTTPS tunneling (HTTP-only proxy)
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('HTTP/1.1 501 Not Implemented\r\n\r\nThis proxy supports HTTP only. HTTPS tunneling not available.');
    return;
  }

  // Parse the target URL (expects full URL in req.url, e.g., http://example.com/path)
  const parsedUrl = url.parse(req.url);
  if (!parsedUrl.protocol || parsedUrl.protocol !== 'http:') {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request: Only HTTP URLs supported.');
    return;
  }

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 80,
    path: parsedUrl.path,
    method: req.method,
    headers: req.headers
  };
  // Remove proxy-specific headers before forwarding
  delete options.headers['proxy-authorization'];

  // Forward the HTTP request
  const proxyReq = http.request(options, (proxyRes) => {
    // Copy response headers (filter out hop-by-hop headers for cleanliness)
    const headers = { ...proxyRes.headers };
    delete headers.connection;
    delete headers['proxy-connection'];
    delete headers['keep-alive'];

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res, { end: true });
  });

  // Pipe request body and headers
  req.pipe(proxyReq, { end: true });

  // Handle proxy request errors
  proxyReq.on('error', (err) => {
    console.error('Proxy request error:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Proxy Error: Unable to connect to target server.');
  });

  // Set timeout
  proxyReq.setTimeout(TIMEOUT, () => {
    proxyReq.destroy();
    res.writeHead(408, { 'Content-Type': 'text/plain' });
    res.end('Request Timeout.');
  });
});

// Start the server (bind to 0.0.0.0 for Render)
server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`HTTP-only proxy server with basic auth and /users endpoint running on ${PROXY_HOST}:${PROXY_PORT}`);
  console.log('Access users (plain text): https://${PROXY_HOST}/users'); // Render uses HTTPS externally
  console.log('Example proxy with auth: curl -x http://${PROXY_HOST} -U user1:pass1 http://httpbin.org/ip');
  console.log('Supports 100 unique users with credentials. Handles concurrent requests efficiently (free tier limits apply).');
});

// Graceful shutdown
process.on('SIGINT', () => {
  server.close(() => {
    console.log('Proxy server stopped.');
    process.exit(0);
  });
});
