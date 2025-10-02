# Instructions

create file named proxies.txt containing proxy in each line the format `protocol://username:pass@host:port`

```
npm install proxy-chain socksv5 winston winston-daily-rotate-file
mkdir logs
node index.js
```


Paths

```
Public logs available at http://localhost:3000/ (tailed)
Full logs at /logs
Full user_proxies.txt at /user_proxies.txt
Health status at /health (JSON, public)
Metrics at /metrics (public)
```
