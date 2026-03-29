# OurBackyard PoC - Phase 1: P2P WebRTC Signaling Server
# 運行方式:
#   pip install fastapi uvicorn websockets
#   uvicorn server:app --reload --port 8080

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Dict, List, Optional
import asyncio
import base64
import binascii
import hashlib
import json
import os
import time
import uuid

app = FastAPI(title="OurBackyard Signaling Server")

DEFAULT_ORIGINS = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("OB_ALLOW_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",")
    if origin.strip()
]
UPLOADS_ENABLED = os.getenv("OB_ENABLE_UPLOADS", "0") == "1"
MAX_UPLOAD_BYTES = int(os.getenv("OB_MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp"}

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ============ TURN 配置 ============
TURN_CONFIG = {
    "stun": [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
    ],
    # 部署 Coturn 後填入
    "turn": [],  
    "turns": [],
    "username": "",
    "credential": ""
}

# ============ 房間物品存儲 ============
room_items: Dict[str, List[dict]] = {}  # room_id -> [items]

# ============ 房間管理 ============
class Room:
    def __init__(self, room_id: str, topic: str = None):
        self.room_id = room_id
        self.topic = topic
        self.clients: Dict[str, WebSocket] = {}
        self.created_at = time.time()

rooms: Dict[str, Room] = {}

def generate_peer_id() -> str:
    import random
    return "peer_" + "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=9))


# ============ WebSocket 端點 ============
@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()
    
    peer_id = generate_peer_id()
    
    # 創建或獲取房間
    if room_id not in rooms:
        rooms[room_id] = Room(room_id)
    
    room = rooms[room_id]
    room.clients[peer_id] = websocket
    
    print(f"[+] {peer_id} joined room: {room_id} ({len(room.clients)} clients)")
    
    try:
        # 發送歡迎訊息 + TURN 配置
        await websocket.send_json({
            "type": "sys",
            "msg": f"Joined {room_id}",
            "peerId": peer_id,
            "peerCount": len(room.clients),
            "peers": list(room.clients.keys()),
            "turn": TURN_CONFIG
        })
        
        # 廣播新用戶加入
        await broadcast_to_room(room_id, {
            "type": "peer-joined",
            "peerId": peer_id,
            "peerCount": len(room.clients)
        }, exclude_peer=peer_id)
        
        # 發送歷史物品給新用戶
        if room_id in room_items and len(room_items[room_id]) > 0:
            print(f"[HISTORY] Sending {len(room_items[room_id])} items to new peer {peer_id}")
            for item in room_items[room_id]:
                await websocket.send_json({
                    "type": "NEW_ITEM",
                    "item": item
                })
        
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # 處理各類訊息
            msg_type = message.get("type")
            
            if msg_type == "offer":
                # WebRTC offer - 轉發給目標peer
                target = message.get("target")
                if target and target in room.clients:
                    await room.clients[target].send_json({
                        "type": "offer",
                        "sdp": message.get("sdp"),
                        "from": peer_id
                    })
                    
            elif msg_type == "answer":
                # WebRTC answer - 轉發給目標peer
                target = message.get("target")
                if target and target in room.clients:
                    await room.clients[target].send_json({
                        "type": "answer",
                        "sdp": message.get("sdp"),
                        "from": peer_id
                    })
                    
            elif msg_type == "ice-candidate":
                # ICE candidate - 轉發給目標peer
                target = message.get("target")
                if target and target in room.clients:
                    await room.clients[target].send_json({
                        "type": "ice-candidate",
                        "candidate": message.get("candidate"),
                        "from": peer_id
                    })
                    
            elif msg_type == "text":
                # 普通訊息 - 廣播
                content = message.get("content", "")
                print(f"[TEXT] Broadcasting from {peer_id}: {content[:50]}")
                msg_data = {
                    "type": "text",
                    "from": peer_id,
                    "content": content,
                    "timestamp": time.time()
                }
                await broadcast_to_room(room_id, msg_data, exclude_peer=peer_id)
                    
            elif msg_type == "get-peers":
                # 獲取房間內所有peer
                await websocket.send_json({
                    "type": "peers",
                    "peers": list(room.clients.keys()),
                    "excluding": peer_id
                })
                
            elif msg_type == "NEW_ITEM":
                # 廣播新物品給房間內所有人
                print(f"[NEW_ITEM] Broadcasting from {peer_id}")
                
                # 存儲物品
                if room_id not in room_items:
                    room_items[room_id] = []
                item = message.get("item", {})
                room_items[room_id].append(item)
                
                # 廣播
                await broadcast_to_room(room_id, message, exclude_peer=peer_id)
                
            elif msg_type == "REQUEST_HISTORY":
                # 新用戶請求歷史物品
                if room_id in room_items and len(room_items[room_id]) > 0:
                    print(f"[HISTORY] Sending {len(room_items[room_id])} items to {peer_id}")
                    for item in room_items[room_id]:
                        await websocket.send_json({
                            "type": "NEW_ITEM",
                            "item": item
                        })
                # 去中心化：也從其他 Peers 請求
                await broadcast_to_room(room_id, {
                    "type": "REQUEST_PEER_ITEMS",
                    "from": peer_id
                }, exclude_peer=peer_id)
                
            elif msg_type == "SYNC_REQUEST":
                # Merkle 同步請求 - 廣播給其他 Peers
                print(f"[SYNC] Received from {peer_id}")
                await broadcast_to_room(room_id, message, exclude_peer=peer_id)
                
            elif msg_type == "SYNC_RESPONSE":
                # Merkle 同步響應 - 轉發給請求者
                print(f"[SYNC] Broadcasting response from {peer_id}")
                await broadcast_to_room(room_id, message, exclude_peer=peer_id)
            
            elif msg_type == "REQ_IMAGE":
                # 圖片請求 - 廣播給所有 Peers
                print(f"[REQ_IMAGE] Broadcasting image request from {peer_id}: {message.get('imageHash')}")
                await broadcast_to_room(room_id, message, exclude_peer=peer_id)
                
            elif msg_type == "IMG_HEADER":
                # 圖片頭部 - 廣播給所有 Peers
                print(f"[IMG_HEADER] Broadcasting from {peer_id}")
                await broadcast_to_room(room_id, message, exclude_peer=peer_id)
                
            elif msg_type == "IMG_CHUNK":
                # 圖片數據塊 - 廣播給所有 Peers
                await broadcast_to_room(room_id, message, exclude_peer=peer_id)
                
            elif msg_type == "IMG_END":
                # 圖片結束 - 廣播給所有 Peers
                print(f"[IMG_END] Broadcasting from {peer_id}")
                await broadcast_to_room(room_id, message, exclude_peer=peer_id)
            
            elif msg_type == "CHAT":
                # Chat message - route to specific peer or broadcast
                target = message.get("to")
                if target:
                    # Direct message to specific peer
                    if target in room.clients:
                        await room.clients[target].send_json(message)
                    else:
                        # Peer not found, send back to sender
                        await websocket.send_json({
                            "type": "error",
                            "msg": "Peer not found"
                        })
                else:
                    # Broadcast to all
                    await broadcast_to_room(room_id, message, exclude_peer=peer_id)
                
    except WebSocketDisconnect:
        print(f"[-] {peer_id} left room: {room_id}")
    finally:
        if room_id in rooms and peer_id in rooms[room_id].clients:
            del rooms[room_id].clients[peer_id]
            
            # 通知其他人
            await broadcast_to_room(room_id, {
                "type": "peer-left",
                "peerId": peer_id,
                "peerCount": len(rooms[room_id].clients)
            })
            
            # 清理空房間
            if len(rooms[room_id].clients) == 0:
                del rooms[room_id]


async def broadcast_to_room(room_id: str, message: dict, exclude_peer: str = None):
    """廣播訊息到房間內所有客戶端"""
    if room_id not in rooms:
        return
    
    room = rooms[room_id]
    msg_text = json.dumps(message)
    
    for peer_id, ws in room.clients.items():
        if peer_id != exclude_peer:
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[!] Send error to {peer_id}: {e}")


# ============ REST API ============
@app.get("/")
async def root():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.get("/{filename}")
async def serve_static(filename: str):
    """Serve static files including sw.js"""
    file_path = os.path.join(BASE_DIR, filename)
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")


@app.get("/v2")
async def root_v2():
    """V2 新版頁面 - 開發測試版本"""
    file_path = os.path.join(BASE_DIR, "index-v2.html")
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="index-v2.html is not available in this build")
    return FileResponse(file_path)


@app.get("/api/config")
async def get_config():
    """返回 TURN 服務器配置"""
    return TURN_CONFIG


@app.post("/api/config/turn")
async def set_turn_config(config: dict):
    """設置 TURN 服務器配置"""
    global TURN_CONFIG
    TURN_CONFIG.update(config)
    return {"status": "ok", "config": TURN_CONFIG}


@app.get("/api/rooms")
async def list_rooms():
    """列出所有房間"""
    return {
        room_id: {
            "topic": room.topic,
            "peerCount": len(room.clients),
            "createdAt": room.created_at
        }
        for room_id, room in rooms.items()
    }


@app.get("/api/rooms/{room_id}")
async def get_room(room_id: str):
    """獲取房間詳情"""
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    room = rooms[room_id]
    return {
        "roomId": room.room_id,
        "topic": room.topic,
        "peers": list(room.clients.keys()),
        "peerCount": len(room.clients)
    }


BUCKET_PATH = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(BUCKET_PATH, exist_ok=True)

@app.post("/api/upload/image")
async def upload_image(data: dict):
    """上傳圖片並返回 URL"""
    if not UPLOADS_ENABLED:
        raise HTTPException(status_code=403, detail="Legacy uploads are disabled")

    image_data = data.get("image")  # base64 encoded
    if not image_data:
        raise HTTPException(status_code=400, detail="No image data")

    if "," in image_data and image_data.startswith("data:"):
        image_data = image_data.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(image_data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="Invalid base64 image payload") from exc

    if len(image_bytes) == 0:
        raise HTTPException(status_code=400, detail="Decoded image is empty")
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Image exceeds {MAX_UPLOAD_BYTES} byte limit")

    file_ext = str(data.get("ext", "jpg")).lower().strip(".")
    if file_ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported image extension")

    file_id = hashlib.md5(str(uuid.uuid4()).encode()).hexdigest()[:12]
    filename = f"{file_id}.{file_ext}"
    filepath = os.path.join(BUCKET_PATH, filename)

    with open(filepath, "wb") as f:
        f.write(image_bytes)

    return {
        "success": True,
        "url": f"/uploads/{filename}",
        "size": len(image_bytes)
    }


@app.get("/uploads/{filename}")
async def get_uploaded_image(filename: str):
    """提供上傳的圖片"""
    filepath = os.path.join(BUCKET_PATH, filename)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Image not found")
    
    # 根據擴展名判斷 content-type
    ext = filename.split('.')[-1].lower()
    content_type = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg", 
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp"
    }.get(ext, "image/jpeg")
    
    from fastapi.responses import FileResponse
    return FileResponse(filepath, media_type=content_type)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
