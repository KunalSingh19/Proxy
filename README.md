# Instructions

create file named proxies.txt containing proxy in each line the format `protocol://username:pass@host:port`

```
npm install proxy-chain socksv5 winston winston-daily-rotate-file
mkdir logs
node index.js
```


Paths

[INFO] Public logs available at http://localhost:3000/ (tailed)

[INFO] Full logs at /logs

[INFO] Full user_proxies.txt at /user_proxies.txt

[INFO] Health status at /health (JSON, public)

[INFO] Metrics at /metrics (public)

