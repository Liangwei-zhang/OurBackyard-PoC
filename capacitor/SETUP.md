# Capacitor Setup Guide

## Install Dependencies

```bash
npm install @capacitor/push-notifications @capacitor/network
npx cap sync
```

## iOS Configuration

### Push Notifications (APNs)

In `ios/App/App/Info.plist`:

```xml
<!-- Push Notifications -->
<key>UIBackgroundModes</key>
<array>
  <string>remote-notification</string>
</array>

<!-- Location (for H3) -->
<key>NSLocationWhenInUseUsageDescription</key>
<string>OurBackyard needs your location to find nearby neighbors.</string>

<!-- Local Network -->
<key>NSLocalNetworkUsageDescription</key>
<string>OurBackyard needs to discover nearby neighbors on your local network.</string>
<key>NSBonjourServices</key>
<array>
  <string>_ourbackyard._tcp</string>
</array>
```

### Enable Push Capability

1. Open Xcode project: `ios/App/App.xcworkspace`
2. Select your app target
3. Go to Signing & Capabilities
4. Add "Push Notifications" capability
5. Add "Background Modes" → "Remote notifications"

## Android Configuration

In `android/app/src/main/AndroidManifest.xml`:

```xml
<!-- Push Permissions -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<uses-permission android:name="android.permission.VIBRATE"/>

<!-- Internet -->
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>

<!-- Location -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
```

### Enable Push in AndroidManifest.xml

```xml
<application ...>
  <meta-data android:name="com.google.firebase.messaging.default_notification_icon" 
    android:resource="@drawable/ic_launcher"/>
  
  <service android:name="com.google.firebase.messaging.FirebaseMessagingService"
    android:exported="false">
    <intent-filter>
      <action android:name="com.google.firebase.MESSAGING_EVENT"/>
    </intent-filter>
  </service>
</application>
```

## Firebase Setup (for Android Push)

1. Go to Firebase Console
2. Create new project
3. Add Android app
4. Download `google-services.json`
5. Place in `android/app/`

```bash
# In android folder
npm install @react-native-firebase/app
```

## APNs Setup (for iOS Push)

1. Go to Apple Developer Portal
2. Create App ID with Push Notifications
3. Create APNs Auth Key or Certificate
4. Upload to Firebase or use directly

## Build APK

```bash
# Android
npx cap add android
npx cap sync android
npx cap open android

# Build in Android Studio:
# Build → Generate Signed Bundle/APK → APK
```

## Firebase Cloud Messaging (FCM)

### Server-side (Python)

```python
import firebase_admin
from firebase_admin import messaging

def send_push(token, title, body, data):
    message = messaging.Message(
        notification=messaging.Notification(
            title=title,
            body=body
        ),
        data=data,
        token=token
    )
    messaging.send(message)
```

### Send Silent Push

```python
message = messaging.Message(
    apns=messaging.APNSConfig(
        payload=messaging.APNSPayload(
            aps=messaging.Aps(
                content_available=True
            )
        )
    ),
    data={'type': 'sos', 'sender': 'John', 'location': '123 Main St'},
    token=device_token
)
```

## Testing

### Test Push (Android)

```bash
# Send test push via FCM
curl -X POST https://fcm.googleapis.com/fcm/send \
  -H "Authorization: key=YOUR_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "DEVICE_TOKEN",
    "notification": {
      "title": "Test",
      "body": "Hello!"
    },
    "data": {
      "type": "sos"
    }
  }'
```

### Test Local Network Discovery

1. Connect two devices to same WiFi
2. Open app on both devices
3. Check console for "Found local peer"
