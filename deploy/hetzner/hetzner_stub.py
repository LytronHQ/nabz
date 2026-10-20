#!/usr/bin/env python3
"""A stub of the Hetzner Cloud endpoints provision.sh calls.

It exists so provision_test.sh can run the REAL script — its preflight, its
create payloads and the NODES block it prints — against something that behaves
like the API, including the one refusal that matters here: a server cannot join
a private network in another network zone. State lives in a JSON file so the
test can pre-create servers and inspect every request that was made.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1])
STATE = os.path.join(sys.argv[2], "state.json")

LOCATIONS = [
    {"name": "fsn1", "network_zone": "eu-central"},
    {"name": "nbg1", "network_zone": "eu-central"},
    {"name": "hel1", "network_zone": "eu-central"},
    {"name": "sin", "network_zone": "ap-southeast"},
]
# Where each type is sold, as /server_types reports it.
TYPES = {
    "cx23": ["fsn1", "nbg1", "hel1"],
    "cpx02": ["fsn1", "nbg1", "hel1", "sin"],
}

if not os.path.exists(STATE):
    json.dump({"servers": [], "networks": [], "firewalls": [], "placement_groups": [],
               "volumes": [], "ssh_keys": [], "requests": [], "next_id": 100},
              open(STATE, "w"))


def load():
    return json.load(open(STATE))


def save(s):
    json.dump(s, open(STATE, "w"))


def next_id(s):
    s["next_id"] += 1
    return s["next_id"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        return self._send({"error": {"code": "invalid_input", "message": msg}}, code)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path.removeprefix("/v1")
        s = load()
        if p == "/health":
            return self._send({})
        if p == "/locations":
            return self._send({"locations": LOCATIONS})
        if p == "/server_types":
            locs = TYPES.get(q.get("name"), [])
            st = [{"name": q.get("name"), "prices": [{"location": l} for l in locs]}] if locs else []
            return self._send({"server_types": st})
        if p == "/ssh_keys":
            return self._send({"ssh_keys": s["ssh_keys"]})
        for coll in ("servers", "networks", "firewalls", "placement_groups", "volumes"):
            if p == "/" + coll:
                items = s[coll]
                if "name" in q:
                    items = [i for i in items if i["name"] == q["name"]]
                return self._send({coll: items})
            if p.startswith("/" + coll + "/"):
                rid = int(p.split("/")[2])
                one = [i for i in s[coll] if i["id"] == rid]
                return self._send({coll[:-1]: one[0]}) if one else self._err(404, "not found")
        return self._err(404, "unhandled GET " + p)

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path.removeprefix("/v1")
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or "{}")
        s = load()
        s["requests"].append({"method": "POST", "path": p, "body": body})

        if p == "/ssh_keys":
            k = {"id": next_id(s), "name": body["name"], "fingerprint": "stub"}
            s["ssh_keys"].append(k); save(s)
            return self._send({"ssh_key": k}, 201)
        if p == "/placement_groups":
            g = {"id": next_id(s), "name": body["name"]}
            s["placement_groups"].append(g); save(s)
            return self._send({"placement_group": g}, 201)
        if p == "/firewalls":
            f = {"id": next_id(s), "name": body["name"], "labels": body.get("labels", {}),
                 "applied_to": body.get("apply_to", [])}
            s["firewalls"].append(f); save(s)
            return self._send({"firewall": f}, 201)
        if p == "/networks":
            n = {"id": next_id(s), "name": body["name"], "ip_range": body["ip_range"],
                 "network_zone": body["subnets"][0]["network_zone"], "routes": []}
            s["networks"].append(n); save(s)
            return self._send({"network": n}, 201)
        if p == "/servers":
            loc = body["location"]
            zone = {l["name"]: l["network_zone"] for l in LOCATIONS}[loc]
            if loc not in TYPES.get(body["server_type"], []):
                save(s)
                return self._err(422, "server type %s not available in %s" % (body["server_type"], loc))
            priv = []
            for nid in body.get("networks", []):
                net = [n for n in s["networks"] if n["id"] == nid][0]
                # The refusal the change under test exists to avoid.
                if net["network_zone"] != zone:
                    save(s)
                    return self._err(422, "network is in %s, server location %s is in %s"
                                     % (net["network_zone"], loc, zone))
                priv.append({"network": nid, "ip": "10.0.0.%d" % (len(s["servers"]) + 2)})
            sid = next_id(s)
            srv = {"id": sid, "name": body["name"], "location": {"name": loc},
                   "server_type": {"name": body["server_type"]},
                   "public_net": {"ipv4": {"ip": "192.0.2.%d" % (sid % 250)}},
                   "private_net": priv, "labels": body.get("labels", {}),
                   "placement_group": body.get("placement_group")}
            s["servers"].append(srv); save(s)
            return self._send({"server": srv}, 201)
        if p == "/volumes":
            v = {"id": next_id(s), "name": body["name"], "size": body["size"],
                 "server": body.get("server"), "linux_device": "/dev/disk/by-id/scsi-0HC_Volume_stub"}
            s["volumes"].append(v); save(s)
            return self._send({"volume": v}, 201)
        if p.startswith("/servers/") and p.endswith("/actions/attach_to_network"):
            sid = int(p.split("/")[2])
            srv = [x for x in s["servers"] if x["id"] == sid][0]
            net = [n for n in s["networks"] if n["id"] == body["network"]][0]
            loc_zone = {l["name"]: l["network_zone"] for l in LOCATIONS}[srv["location"]["name"]]
            if net["network_zone"] != loc_zone:
                save(s)
                return self._err(422, "cannot attach a %s server to a %s network" % (loc_zone, net["network_zone"]))
            srv["private_net"].append({"network": net["id"], "ip": "10.0.0.%d" % (sid % 250)})
            save(s)
            return self._send({"action": {"status": "running"}}, 201)
        if "/actions/" in p:
            save(s)
            return self._send({"action": {"status": "running"}}, 201)
        save(s)
        return self._err(404, "unhandled POST " + p)

    def do_DELETE(self):
        s = load()
        s["requests"].append({"method": "DELETE", "path": urlparse(self.path).path, "body": None})
        save(s)
        return self._send({})


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
