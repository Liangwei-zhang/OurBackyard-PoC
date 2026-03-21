# Silent Push Notification System

## FastAPI Backend

### Install dependencies
```bash
pip install firebase-admin pyapns2
```

### server_push.py - Push Notification Service
```python
from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
import asyncio

app = FastAPI()

# Push notification models
class PushNotification(BaseModel):
    token: str
    title: str
    body: str
    data: dict = {}

class SilentPush(BaseModel):
    h3_index: str
    sender: str
    location: str
    timestamp: int

# Store device tokens (in production, use Redis/DB)
device_tokens: dict = {}  # h3_index -> [tokens]

@app.post("/register")
async def register_device(h3_index: str, token: str):
    """Register device token for a H3 zone"""
    if h3_index not in device_tokens:
        device_tokens[h3_index] = []
    if token not in device_tokens[h3_index]:
        device_tokens[h3_index].append(token)
    return {"status": "ok"}

@app.post("/push/silent")
async def send_silent_push(notification: SilentPush, background_tasks: BackgroundTasks):
    """Send silent push to all devices in H3 zone"""
    tokens = device_tokens.get(notification.h3_index, [])
    
    # Send silent push in background
    background_tasks.add_task(send_ios_silent_push, tokens, notification)
    
    return {"status": "sent", "count": len(tokens)}

async def send_ios_silent_push(tokens, notification):
    """Send APNs silent push"""
    # In production, use proper APNs connection
    # This is a placeholder for the concept
    for token in tokens:
        payload = {
            "aps": {
                "content-available": 1,
                "alert": {
                    "title": "🚨 Emergency SOS",
                    "body": f"{notification.sender} needs help at {notification.location}"
                }
            },
            "data": {
                "type": "sos",
                "sender": notification.sender,
                "location": notification.location
            }
        }
        # Send via APNs
        print(f"[PUSH] Would send to {token}: {payload}")

@app.post("/push/fcm")
async def send_fcm_push(notification: SilentPush):
    """Send Firebase Cloud Message (Android)"""
    # Implement FCM sending here
    pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
```

## Capacitor Frontend Integration

### Install plugins
```bash
npm install @capacitor/push-notifications
npx cap sync
```

### Push Service (JavaScript)
```javascript
// push-service.js
import { PushNotifications } from '@capacitor/push-notifications';

const PushService = {
  async init() {
    // Request permission
    const result = await PushNotifications.requestPermissions();
    if (result.receive !== 'granted') {
      console.log('Push permission denied');
      return false;
    }
    
    // Register device
    await PushNotifications.register();
    
    // Listen for notifications
    PushNotifications.addEventListener('push', (notification) => {
      console.log('Push received:', notification);
      
      // Handle silent push
      if (notification.notification.data.contentAvailable) {
        this.handleBackgroundSync(notification.notification.data);
      }
    });
    
    // Get token
    const token = await PushNotifications.getToken();
    console.log('Push token:', token.token);
    
    // Register with backend
    await this.registerWithBackend(token.token);
    
    return true;
  },
  
  async registerWithBackend(token) {
    const h3Index = currentH3Index;
    await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ h3_index: h3Index, token })
    });
  },
  
  async handleBackgroundSync(data) {
    // Reconnect WebSocket
    connect();
    
    // Request latest items
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'REQUEST_HISTORY' }));
    }, 2000);
  },
  
  // Trigger SOS silent push
  async sendSOSNotification(location) {
    await fetch('/push/silent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        h3_index: roomId,
        sender: displayName,
        location: location,
        timestamp: Date.now()
      })
    });
  }
};

export default PushService;
```
