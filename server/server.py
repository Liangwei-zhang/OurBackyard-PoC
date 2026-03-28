# OurBackyard — Pure P2P Signaling Server (v2.0)
# 
# Design principles:
#   ✅ Only relay SDP/ICE signaling (a few hundred bytes, one-time per connection)
#   ✅ Only track peer presence (join/leave)
#   ✅ Zero data storage — no items, no images, no messages
#   ✅ Zero external API dependency — self-hosted STUN/TURN only
#   ✅ Minimal memory footprint → target 1M daily active on single machine
#
# Run:
#   pip install fastapi uvicorn websockets
#   uvicorn server.server:app --reload --port 7070

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict
import json
import os
import re
import secrets
import time

app = FastAPI(title="OurBackyard Signaling Server v2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ============ Self-hosted ICE config ============
ICE_CONFIG = {
    "iceServers": [],
    "ttl": 3600,
}

MAX_ROOMS = 100_000

class Room:
    __slots__ = ('clients', 'created_at')
    def __init__(self):
        self.clients: Dict[str, WebSocket] = {}
        self.created_at: float = time.time()

rooms: Dict[str, Room] = {}

def _peer_id() -> str:
    return "p_" + secrets.token_hex(6)

@app.websocket("/ws/{room_id}")
async def ws_signaling(websocket: WebSocket, room_id: str):
    await websocket.accept()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,50}', room_id):
        await websocket.send_json({"type": "error", "msg": "Invalid room ID"})
        await websocket.close(code=1008)
        return

    peer_id = _peer_id()

    if room_id not in rooms and len(rooms) >= MAX_ROOMS:
        await websocket.send_json({"type": "error", "msg": "Server at capacity"})
        await websocket.close(code=1013)
        return

    if room_id not in rooms:
        rooms[room_id] = Room()
    room = rooms[room_id]
    room.clients[peer_id] = websocket

    try:
        await websocket.send_json({
            "type": "welcome",
            "peerId": peer_id,
            "peers": [pid for pid in room.clients if pid != peer_id],
        })
        await websocket.send_json({"type": "ice-config", "config": ICE_CONFIG})
        await _broadcast(room, {"type": "peer-joined", "peerId": peer_id}, exclude=peer_id)

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            t = msg.get("type")

            if t in ("signal", "WEBRTC_SIGNAL"):
                target = msg.get("target")
                if target and target in room.clients:
                    try:
                        await room.clients[target].send_json({
                            "type": t, "from": peer_id, "signal": msg.get("signal"),
                        })
                    except Exception:
                        pass

            elif t == "announce":
                await _broadcast(room, {
                    "type": "announce", "peerId": peer_id, "meta": msg.get("meta", {}),
                }, exclude=peer_id)

            elif t in ("offer", "answer", "ice-candidate"):
                target = msg.get("target")
                if target and target in room.clients:
                    relay = {"type": t, "from": peer_id}
                    if t in ("offer", "answer"):
                        relay["sdp"] = msg.get("sdp")
                    else:
                        relay["candidate"] = msg.get("candidate")
                    try:
                        await room.clients[target].send_json(relay)
                    except Exception:
                        pass

    except WebSocketDisconnect:
        pass
    finally:
        if room_id in rooms and peer_id in rooms[room_id].clients:
            del rooms[room_id].clients[peer_id]
            await _broadcast(rooms.get(room_id), {"type": "peer-left", "peerId": peer_id})
            if room_id in rooms and len(rooms[room_id].clients) == 0:
                del rooms[room_id]

async def _broadcast(room, message, exclude=None):
    if not room:
        return
    dead = []
    for pid, ws in room.clients.items():
        if pid != exclude:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(pid)
    for pid in dead:
        room.clients.pop(pid, None)

@app.get("/health")
async def health():
    total_peers = sum(len(r.clients) for r in rooms.values())
    return {
        "status": "ok",
        "rooms": len(rooms),
        "peers": total_peers,
        "uptime_hours": round((time.time() - _start_time) / 3600, 1),
    }

_start_time = time.time()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

@app.get("/")
async def root():
    from fastapi.responses import FileResponse
    index = os.path.join(BASE_DIR, "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return {"msg": "OurBackyard Signaling Server v2.0"}

@app.get("/{file_path:path}")
async def serve_static(file_path: str):
    from fastapi.responses import FileResponse
    from fastapi import HTTPException
    resolved = os.path.realpath(os.path.join(BASE_DIR, file_path))
    if not resolved.startswith(os.path.realpath(BASE_DIR) + os.sep):
        raise HTTPException(status_code=403)
    if os.path.isfile(resolved):
        return FileResponse(resolved)
    raise HTTPException(status_code=404)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7070)