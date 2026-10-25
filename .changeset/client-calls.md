---
"@katrix/client": patch
---

Voice and video calls on `client.calls` (#117). The SDK handles the Matrix signalling: invites, answers, ICE candidates (batched as the spec suggests), select_answer, renegotiation, rejecting, hanging up, glare, and invite lifetimes. Media goes through the app's WebRTC: pass `calls: { peerConnectionFactory }` (the browser's `RTCPeerConnection`, or react-native-webrtc's), and add your tracks in the setup callback of `place()` and `answer()`. Incoming calls arrive as the `incoming` event; calls in public rooms do not ring. `turnServers()` fetches the homeserver's TURN servers.
