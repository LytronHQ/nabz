# Fixture target server for the e2e stack (#126). Zero-dependency Node stdlib,
# so there's nothing to install — just copy the script and run it.
FROM node:20-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

ENV PORT=8080 TCP_PORT=9090
EXPOSE 8080 9090

# Reachable at http://fixture:8080 (and tcp fixture:9090) from other stack
# services on the compose network.
HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
	CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.mjs"]
