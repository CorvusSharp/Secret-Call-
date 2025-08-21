# AndroidCall

Experimental native Android client for **Secret-Call** server. Written in Kotlin and uses the same WebRTC and WebSocket signalling protocol as the web frontend.

## Features
- Join and leave audio rooms via the existing `/ws` endpoint.
- Peer-to-peer audio using `org.webrtc` library.
- Minimal UI with name/token fields and join/leave button.

> **Note:** This is a basic implementation and does not yet include chat UI, roster display, emoji picker, or audio controls. Those parts of the web app remain TODO.

## Building
Requires Android Studio/Gradle with Android SDK 24+.

```bash
cd AndroidCall
./gradlew assembleDebug
```

When running on an Android emulator the app expects the Secret-Call server to be available at `http://10.0.2.2:8790`.
