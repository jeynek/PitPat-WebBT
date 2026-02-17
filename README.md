# PitPat Treadmill Web Bluetooth Dashboard

**Lightweight Progressive Web App** for real-time control and monitoring of PitPat (and compatible Superun/etc.) treadmills via Web Bluetooth.

### ✨ Features
- Live metrics: Speed, Avg Speed, Distance, Calories, Steps, Duration
- Start / Pause / Stop + Speed +/- control
- Full workout session tracking & history (saved forever in browser)
- Auto-save session history every 5 min as downloadable JSON backup
- Export / Import full history
- PWA – installable on your phone (feels like a native app)
- Tasker integration – push data straight to **Health Connect** on Android
- Resumes sessions automatically after disconnect/reconnect

### Live Demo
https://jeynek.github.io/PitPat-WebBT/

### What's New in This Fork
- Full PWA support (manifest + service worker + icons)
- Much smarter session logic & reconnection
- Complete history table with relative dates
- Auto-export every 5 minutes
- Tasker bridge for Health Connect
- Better status chip, toasts, loading states
- Offline-capable

### How to Use
1. Open on your phone (Chrome recommended)
2. Tap **Add to Home screen** when prompted
3. Turn on your treadmill
4. Tap **Connect** → select your PitPat device
5. Start walking/running!

### Tasker + Health Connect Setup (Android only)
1. Install **Tasker**
2. Create a profile that listens for HTTP POST on port 1821
3. Use this example task (I can send you the exact Tasker profile XML if you want)
4. The app sends every update to `http://127.0.0.1:1821/`

### Troubleshooting
- Must be served over **HTTPS** (GitHub Pages works perfectly)
- Bluetooth only works in Chrome/Edge on Android
- Grant Bluetooth + Local Network Access permissions
- If it doesn't connect → restart treadmill and browser


Credits to the author of the original repo, Grok, Copilot, Claude, ChatGPT and Gemini! 