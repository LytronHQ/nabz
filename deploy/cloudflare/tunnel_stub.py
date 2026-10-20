#!/usr/bin/env python3
# tunnel_stub.py — the slice of the Cloudflare API that tunnel.sh touches, with
# state on disk so a test can assert what a run created and re-run for
# idempotence. Not a general Cloudflare emulator: it answers these paths only.
import json, os, re, sys, uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1])
STATE = sys.argv[2]

def _path(name):
    return os.path.join(STATE, name + ".json")

def load(name, default):
    try:
        with open(_path(name)) as f:
            return json.load(f)
    except FileNotFoundError:
        return default

def save(name, data):
    with open(_path(name), "w") as f:
        json.dump(data, f)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, result, ok=True, status=200):
        body = json.dumps({"success": ok, "errors": [] if ok else result,
                           "result": result if ok else None}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._send("ok")

        # zone lookup by name
        if u.path.endswith("/zones"):
            name = (q.get("name") or [""])[0]
            zones = load("zones", {"example.test": "zone-example-test"})
            save("zones", zones)
            if name in zones:
                return self._send([{"id": zones[name], "name": name}])
            return self._send([])

        # tunnel lookup by name; is_deleted=false must be honoured
        if u.path.endswith("/cfd_tunnel"):
            name = (q.get("name") or [""])[0]
            only_live = (q.get("is_deleted") or ["false"])[0] == "false"
            out = []
            for t in load("tunnels", {}).values():
                if t["name"] != name:
                    continue
                if only_live and t.get("deleted_at"):
                    continue
                out.append(t)
            return self._send(out)

        if re.search(r"/cfd_tunnel/[^/]+/token$", u.path):
            tid = u.path.split("/")[-2]
            return self._send("connector-token-for-" + tid)

        if re.search(r"/cfd_tunnel/[^/]+/configurations$", u.path):
            tid = u.path.split("/")[-2]
            return self._send(load("configs", {}).get(tid, {"config": {}}))

        if u.path.endswith("/dns_records"):
            name = (q.get("name") or [""])[0]
            recs = [r for r in load("dns", {}).values() if r["name"] == name]
            return self._send(recs)

        return self._send([{"unhandled": u.path}])

    def do_POST(self):
        u = urlparse(self.path)
        body = self._body()

        if u.path.endswith("/cfd_tunnel"):
            tid = uuid.uuid4().hex
            tunnels = load("tunnels", {})
            tunnels[tid] = {"id": tid, "name": body["name"], "deleted_at": None}
            save("tunnels", tunnels)
            return self._send(tunnels[tid])

        if u.path.endswith("/dns_records"):
            rid = uuid.uuid4().hex
            recs = load("dns", {})
            recs[rid] = {"id": rid, "name": body["name"], "type": body["type"],
                         "content": body["content"], "proxied": body.get("proxied")}
            save("dns", recs)
            return self._send(recs[rid])

        return self._send({"unhandled": u.path})

    def do_PUT(self):
        u = urlparse(self.path)
        body = self._body()

        if re.search(r"/cfd_tunnel/[^/]+/configurations$", u.path):
            tid = u.path.split("/")[-2]
            cfgs = load("configs", {})
            cfgs[tid] = body
            save("configs", cfgs)
            return self._send(body)

        if re.search(r"/dns_records/[^/]+$", u.path):
            rid = u.path.rsplit("/", 1)[-1]
            recs = load("dns", {})
            recs[rid] = {"id": rid, "name": body["name"], "type": body["type"],
                         "content": body["content"], "proxied": body.get("proxied")}
            save("dns", recs)
            return self._send(recs[rid])

        return self._send({"unhandled": u.path})

    def do_DELETE(self):
        u = urlparse(self.path)
        if re.search(r"/dns_records/[^/]+$", u.path):
            rid = u.path.rsplit("/", 1)[-1]
            recs = load("dns", {})
            recs.pop(rid, None)
            save("dns", recs)
            return self._send({"id": rid})
        return self._send({"unhandled": u.path})

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
