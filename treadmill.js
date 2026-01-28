// treadmill.js - JavaScript logic for PitPat Treadmill Control Dashboard

// --- Bluetooth UUIDs ---
const SERVICE_UUID = "0000fba0-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID = "0000fba2-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID = "0000fba1-0000-1000-8000-00805f9b34fb";

// --- Treadmill to Tasker integration ---
const TASKER_POST_URL = 'http://127.0.0.1:1821/';
const DELTA_INTERVAL_MS = 5 * 60 * 1000;          // 5 minutes
const STRIDE_LENGTH_METERS = 0.75;                // average stride – change if needed (0.65–0.85 typical)

// --- UI Elements ---
const connectBtn = document.getElementById('connectBtn');
const statusDiv = document.getElementById('status');
const speedDiv = document.getElementById('speed');
const distanceDiv = document.getElementById('distance');
const caloriesDiv = document.getElementById('calories');
const stepsDiv = document.getElementById('steps');
const durationDiv = document.getElementById('duration');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const speedUpBtn = document.getElementById('speedUpBtn');
const speedDownBtn = document.getElementById('speedDownBtn');
const speedSlider = document.getElementById('speedSlider');
const sliderValue = document.getElementById('sliderValue');
const statusChip = document.getElementById('statusChip');
const loadingOverlay = document.getElementById('loadingOverlay');
const countdownOverlay = document.getElementById('countdownOverlay');
const countdownNumber = document.getElementById('countdownNumber');
const historyTableBody = document.getElementById('historyTableBody');
const importHistoryBtn = document.getElementById('importHistoryBtn');
const exportHistoryBtn = document.getElementById('exportHistoryBtn');
const importHistoryInput = document.getElementById('importHistoryInput');
const snackbar = document.getElementById('snackbar');

// --- Session History Logic ---
let sessionActive = false;
let sessionStartData = null;
let lastSession = null;

function loadSessions() {
    let sessions = [];
    try {
        sessions = JSON.parse(localStorage.getItem('treadmill_sessions') || '[]');
    } catch {}
    return Array.isArray(sessions) ? sessions : [];
}
function saveSessions(sessions) {
    localStorage.setItem('treadmill_sessions', JSON.stringify(sessions));
}
// Auto-save sessions to a downloadable JSON file every X minutes
function autoSaveSessionsToFile() {
    const sessions = loadSessions();
    if (sessions.length === 0) return;

    const jsonString = JSON.stringify(sessions, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');

    a.download = `pitpat-sessions-(\( {dateStr}_ \){timeStr}).json`;

    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);

    console.log('Auto-saved sessions JSON');
    showToast('Auto-saved session history');
}
function addSession(session) {
    const sessions = loadSessions();
    sessions.unshift(session);
    saveSessions(sessions);
    renderSessionTable();
}
function deleteSession(idx) {
    const sessions = loadSessions();
    sessions.splice(idx, 1);
    saveSessions(sessions);
    renderSessionTable();
}
function renderSessionTable() {
    const sessions = loadSessions();
    historyTableBody.innerHTML = '';
    sessions.forEach((s, i) => {
        let avgSpeedDisplay = '-';
        if (typeof s.avgSpeed === 'number' && !isNaN(s.avgSpeed)) {
            avgSpeedDisplay = s.avgSpeed.toFixed(2) + ' ' + (s.speedUnit || '');
        } else if (typeof s.avgSpeed === 'string' && !isNaN(parseFloat(s.avgSpeed))) {
            avgSpeedDisplay = parseFloat(s.avgSpeed).toFixed(2) + ' ' + (s.speedUnit || '');
        }
        let dateStr = '-';
        if (typeof s.date === 'number' || typeof s.date === 'string') {
            dateStr = dateFns.formatRelative(new Date(s.date), new Date());
        }
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${dateStr}</td>
            <td>${formatDuration(s.duration)}</td>
            <td>${s.steps}</td>
            <td>${s.calories}</td>
            <td>${avgSpeedDisplay}</td>
            <td><button class="mdl-button mdl-js-button mdl-button--icon" title="Delete" onclick="window.deleteSessionFromTable(${i})"><i class="material-icons">delete</i></button></td>
        `;
        historyTableBody.appendChild(tr);
    });
}
window.deleteSessionFromTable = deleteSession;

// --- State ---
let device = null;
let server = null;
let notifyChar = null;
let writeChar = null;
let treadmillData = {};
let connected = false;
let runningState = 3; // 0: Starting, 1: Running, 2: Paused, 3: Stopped
let curTargetSpeed = 1000;

// Treadmill → Tasker delta tracking
let lastSentDistanceMeters = 0;
let lastSentTime = 0;

// --- Helper Functions ---

function setStatus(msg) {
    let displayMsg = msg;
    if (msg.toLowerCase().includes('connecting')) {
        displayMsg = 'Connecting';
    } else if (msg.toLowerCase().includes('not connected') || msg.toLowerCase().includes('disconnect')) {
        displayMsg = 'Disconnected';
    } else if (msg.toLowerCase().includes('paused')) {
        displayMsg = 'Paused';
    } else if (msg.toLowerCase().includes('running')) {
        displayMsg = 'Running';
    } else if (msg.toLowerCase().includes('stopped')) {
        displayMsg = 'Stopped';
    }
    if (statusChip) {
        statusChip.querySelector('.mdl-chip__text').textContent = displayMsg;
        statusChip.classList.remove('chip-connected', 'chip-connecting', 'chip-disconnected', 'chip-paused');
        if (displayMsg === 'Running') {
            statusChip.classList.add('chip-connected');
        } else if (displayMsg === 'Connecting') {
            statusChip.classList.add('chip-connecting');
        } else if (displayMsg === 'Paused') {
            statusChip.classList.add('chip-paused');
        } else {
            statusChip.classList.add('chip-disconnected');
        }
    }
}
function updateDashboard(data) {
    speedDiv.textContent = data.speed || '-';
    distanceDiv.textContent = data.distance || '-';
    caloriesDiv.textContent = data.calories || '-';
    stepsDiv.textContent = (data.steps !== undefined && data.steps !== null) ? data.steps : '-';
    if (data.duration && typeof data.duration === 'number') {
        durationDiv.textContent = formatDuration(data.duration);
    } else if (typeof data.duration === 'string' && !isNaN(parseFloat(data.duration))) {
        durationDiv.textContent = formatDuration(parseFloat(data.duration));
    } else {
        durationDiv.textContent = data.duration || '-';
    }
}
function enableControls(enable) {
    startBtn.disabled = !enable;
    stopBtn.disabled = !enable;
    speedUpBtn.disabled = !enable;
    speedDownBtn.disabled = !enable;
    speedSlider.disabled = !enable;
}
function updateRunningState(state) {
    runningState = state;
    if (!connected) {
        enableControls(false);
        startBtn.textContent = "Start";
        setStatus('Disconnected');
    } else {
        switch (state) {
            case 0: // Starting
                enableControls(false);
                startBtn.textContent = "Start";
                break;
            case 1: // Running
                enableControls(true);
                startBtn.textContent = "Pause";
                setStatus('Running');
                break;
            case 2: // Paused
                enableControls(true);
                startBtn.textContent = "Start";
                setStatus('Paused');
                break;
            case 3: // Stopped
                enableControls(true);
                startBtn.textContent = "Start";
                setStatus('Stopped');
                break;
            default:
                enableControls(false);
                startBtn.textContent = "Start";
                setStatus('Disconnected');
        }
    }
}
function formatDuration(seconds) {
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    let parts = [];
    if (h > 0) parts.push(h + 'h');
    if (m > 0 || h > 0) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
}

// --- Send Data Logic ---
let pendingData = null;
function send_data(packet) {
    pendingData = packet;
}

// --- Bluetooth Logic ---
async function connectBluetooth() {
    setStatus('Connecting');
    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    try {
        console.log("Requesting Bluetooth device...");
        device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [SERVICE_UUID] }],
            services: [SERVICE_UUID]
        });
        console.log("Device selected:", device);
        setStatus('Connecting');
        device.addEventListener('gattserverdisconnected', onDisconnected);
        server = await device.gatt.connect();
        console.log("GATT server connected:", server);
        let services = await server.getPrimaryServices();
        console.log("Primary services:", services.map(s => s.uuid));
        notifyChar = await server.getPrimaryService(SERVICE_UUID).then(
            service => service.getCharacteristic(NOTIFY_CHAR_UUID)
        ).catch(async () => {
            let services = await server.getPrimaryServices();
            for (let s of services) {
                try {
                    let c = await s.getCharacteristic(NOTIFY_CHAR_UUID);
                    if (c) return c;
                } catch {}
            }
            throw new Error("Notify characteristic not found");
        });
        console.log("Notify characteristic:", notifyChar);
        writeChar = await server.getPrimaryService(SERVICE_UUID).then(
            service => service.getCharacteristic(WRITE_CHAR_UUID)
        ).catch(async () => {
            let services = await server.getPrimaryServices();
            for (let s of services) {
                try {
                    let c = await s.getCharacteristic(WRITE_CHAR_UUID);
                    if (c) return c;
                } catch {}
            }
            throw new Error("Write characteristic not found");
        });
        console.log("Write characteristic:", writeChar);
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', handleNotification);
        connected = true;
        setStatus('Stopped');
        connectBtn.textContent = "Disconnect";
        updateRunningState(3);
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    } catch (err) {
        console.error("Bluetooth connection error:", err);
        showToast("Bluetooth error: " + err);
        setStatus('Disconnected');
        connected = false;
        connectBtn.textContent = "Connect";
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    }
}

function disconnectBluetooth() {
    if (device && device.gatt.connected) {
        device.gatt.disconnect();
    }
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    setStatus('Disconnected');
}

function onDisconnected() {
    connected = false;
    setStatus('Disconnected');
    connectBtn.textContent = "Connect";
    updateRunningState(3);
    if (sessionActive && sessionStartData) {
        finishSession('Disconnected');
    }
}

function handleNotification(event) {
    const value = event.target.value;
    console.log("Received notification, byteLength:", value.byteLength);
    let hexStr = [];
    for (let i = 0; i < value.byteLength; ++i) {
        hexStr.push(value.getUint8(i).toString(16).padStart(2, "0"));
    }
    console.log("Payload (hex):", hexStr.join(" "));

    if (value.byteLength < 31) {
        treadmillData = {
            speed: "-",
            distance: "-",
            calories: "-",
            steps: "-",
            duration: "-",
            status: "Invalid"
        };
        updateDashboard(treadmillData);
        updateRunningState(3);
        if (sessionActive && sessionStartData) {
            finishSession('Disconnected');
        }
        return;
    }

    function u16(offset) {
        return (value.getUint8(offset) << 8) | value.getUint8(offset + 1);
    }
    function u32(offset) {
        return (value.getUint8(offset) << 24) | (value.getUint8(offset + 1) << 16) | (value.getUint8(offset + 2) << 8) | value.getUint8(offset + 3);
    }

    const current_speed = u16(3);
    const distance = u32(7);                    // raw value (millimeters or similar)
    const calories = (value.getUint8(18) << 8) | value.getUint8(19);
    const steps = u32(14);                      // will be 0 on your model
    const duration = u32(20);
    const flags = value.getUint8(26);
    const unit_mode = (flags & 128) === 128 ? 1 : 0;
    const running_state_bits = flags & 24;
    let running_state = 3;
    if (running_state_bits === 24) running_state = 0;
    else if (running_state_bits === 8) running_state = 1;
    else if (running_state_bits === 16) running_state = 2;
    else running_state = 3;

    const statusArr = ["Starting", "Running", "Paused", "Stopped"];
    const speed_unit = unit_mode === 1 ? "mph" : "kph";
    const distance_unit = unit_mode === 1 ? "mi" : "km";

    treadmillData = {
        speed: (current_speed / 1000).toFixed(2) + " " + speed_unit,
        distance: (distance / 1000).toFixed(2) + " " + distance_unit,
        calories: calories + " kcal",
        steps: steps,
        duration: Math.round(duration / 1000),
        status: statusArr[running_state] || "Unknown",
        _raw: { current_speed, distance, calories, steps, duration, speed_unit }
    };

    console.log("Parsed treadmill data:", treadmillData);
    updateDashboard(treadmillData);
    updateRunningState(running_state);

    // --- Session tracking ---
    if (running_state === 1 && !sessionActive) {
        sessionActive = true;
        sessionStartData = {
            date: Date.now(),
            steps: steps,
            calories: calories,
            distance: distance,
            duration: Math.round(duration / 1000),
            speedSum: current_speed,
            speedCount: 1,
            speedUnit: speed_unit
        };
        const avgSpeed = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        upsertLiveSession({
            date: sessionStartData.date,
            duration: sessionStartData.duration,
            steps: sessionStartData.steps,
            calories: sessionStartData.calories + ' kcal',
            avgSpeed: avgSpeed,
            speedUnit: sessionStartData.speedUnit || ''
        });
        // Reset delta tracking on new session start
        lastSentDistanceMeters = distance / 1000;
        lastSentTime = Date.now();
        console.log("Session started – delta tracking initialized");
    } else if (running_state === 1 && sessionActive && sessionStartData) {
        sessionStartData.steps = steps;
        sessionStartData.calories = calories;
        sessionStartData.distance = distance;
        sessionStartData.duration = Math.round(duration / 1000);
        sessionStartData.speedSum += current_speed;
        sessionStartData.speedCount += 1;
        const avgSpeed = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        upsertLiveSession({
            date: sessionStartData.date,
            duration: sessionStartData.duration,
            steps: sessionStartData.steps,
            calories: sessionStartData.calories + ' kcal',
            avgSpeed: avgSpeed,
            speedUnit: sessionStartData.speedUnit || ''
        });

        // --- Send estimated steps delta to Tasker ---
        const now = Date.now();
        const currentDistanceMeters = distance / 1000;  // raw distance / 1000 → meters

        if (now - lastSentTime >= DELTA_INTERVAL_MS) {
            const deltaMeters = currentDistanceMeters - lastSentDistanceMeters;
            if (deltaMeters > 0) {
                const estimatedSteps = Math.round(deltaMeters / STRIDE_LENGTH_METERS);

                const payload = {
                    delta_steps: estimatedSteps,
                    start_time: lastSentTime,
                    end_time: now
                };

                fetch(TASKER_POST_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
                .then(response => {
                    if (response.ok) {
                        console.log(`Sent estimated ${estimatedSteps} steps to Tasker (distance delta: ${deltaMeters.toFixed(2)} m)`);
                        lastSentDistanceMeters = currentDistanceMeters;
                        lastSentTime = now;
                    } else {
                        console.warn(`Tasker POST failed: ${response.status}`);
                    }
                })
                .catch(err => {
                    console.error('POST to Tasker failed:', err);
                });
            } else {
                lastSentTime = now;  // no progress, but update time
            }
        }
    } else if ((running_state === 3 || running_state === 2) && sessionActive && sessionStartData) {
        finishSession(running_state === 3 ? 'Stopped' : 'Paused');
    }

    // --- Heartbeat / pending data ---
    if (writeChar) {
        if (pendingData) {
            console.log("Sending pending data packet:", Array.from(pendingData).map(b => b.toString(16).padStart(2, "0")).join(" "));
            writeChar.writeValue(pendingData).then(() => {
                console.log("Pending data sent.");
                pendingData = null;
            }).catch(err => {
                console.error("Failed to send pending data:", err);
            });
        } else {
            const heartbeat = new Uint8Array([0x6a, 0x05, 0xfd, 0xf8, 0x43]);
            console.log("Sending heartbeat packet:", Array.from(heartbeat).map(b => b.toString(16).padStart(2, "0")).join(" "));
            writeChar.writeValue(heartbeat).catch(err => {
                console.error("Failed to send heartbeat:", err);
            });
        }
    }
}

async function sendCommand(packet) {
    if (!writeChar) return;
    try {
        console.log("Sending command packet:", Array.from(packet).map(b => b.toString(16).padStart(2, "0")).join(" "));
        await writeChar.writeValue(packet);
    } catch (err) {
        console.error("Failed to send command:", err);
        showToast("Failed to send command: " + err);
    }
}

function makePacket(type, speed = 1000) {
    let arr = new Uint8Array(23);
    arr[0] = 0x6A;
    arr[1] = 0x17;
    arr[6] = (speed >> 8) & 0xFF;
    arr[7] = speed & 0xFF;
    arr[8] = type === "set_speed" ? 5 : 1;
    arr[9] = 0;
    arr[10] = 80;
    arr[11] = 0;
    let cmd = type === "pause" ? 2 : type === "stop" ? 0 : 4;
    arr[12] = cmd & 0xF7;
    let userId = 58965456623n;
    for (let i = 0; i < 8; ++i) {
        arr[13 + i] = Number((userId >> BigInt(56 - i * 8)) & 0xFFn);
    }
    let checksum = 0;
    for (let i = 1; i <= 20; ++i) {
        checksum ^= arr[i];
    }
    arr[21] = checksum;
    arr[22] = 0x43;
    return arr;
}

// --- UI Event Handlers ---
connectBtn.addEventListener('click', () => {
    if (!connected) connectBluetooth();
    else disconnectBluetooth();
});

startBtn.addEventListener('click', async () => {
    if (!connected) return;
    if (runningState === 1) {
        send_data(makePacket("pause"));
    } else {
        if (countdownOverlay && countdownNumber) {
            countdownOverlay.style.display = 'flex';
            countdownOverlay.style.opacity = '1';
            let count = 3;
            countdownNumber.textContent = count;
            countdownNumber.style.opacity = '1';
            countdownNumber.style.transform = 'scale(1)';
            (async () => {
                for (let i = 0; i < 3; i++) {
                    await new Promise(res => setTimeout(res, 700));
                    countdownNumber.style.transform = 'scale(1.3)';
                    countdownNumber.style.opacity = '0.5';
                    await new Promise(res => setTimeout(res, 200));
                    count--;
                    if (count > 0) {
                        countdownNumber.textContent = count;
                        countdownNumber.style.opacity = '1';
                        countdownNumber.style.transform = 'scale(1)';
                    }
                }
                await new Promise(res => setTimeout(res, 400));
                countdownOverlay.style.opacity = '0';
                await new Promise(res => setTimeout(res, 500));
                countdownOverlay.style.display = 'none';
                countdownOverlay.style.opacity = '1';
            })();
        }
        send_data(makePacket("start", curTargetSpeed));
    }
});

stopBtn.addEventListener('click', () => {
    if (!connected) return;
    send_data(makePacket("stop"));
});

speedUpBtn.addEventListener('click', () => {
    if (!connected) return;
    curTargetSpeed = Math.min(curTargetSpeed + 100, 6000);
    send_data(makePacket("set_speed", curTargetSpeed));
});

speedDownBtn.addEventListener('click', () => {
    if (!connected) return;
    curTargetSpeed = Math.max(curTargetSpeed - 1000, 1000);
    send_data(makePacket("set_speed", curTargetSpeed));
});

speedSlider.addEventListener('input', () => {
    sliderValue.textContent = speedSlider.value;
});
speedSlider.addEventListener('change', () => {
    if (!connected) return;
    curTargetSpeed = Math.round(parseFloat(speedSlider.value) * 1000);
    send_data(makePacket("set_speed", curTargetSpeed));
});

// --- Initialize ---
updateDashboard({});
updateRunningState(3);
sliderValue.textContent = speedSlider.value;
renderSessionTable();

function saveCurrentSession(session) {
    localStorage.setItem('treadmill_current_session', JSON.stringify(session));
}
function loadCurrentSession() {
    try {
        return JSON.parse(localStorage.getItem('treadmill_current_session')) || null;
    } catch { return null; }
}
function clearCurrentSession() {
    localStorage.removeItem('treadmill_current_session');
}

function upsertLiveSession(session) {
    let sessions = loadSessions();
    if (sessions.length > 0 && sessions[0] && sessions[0].date === session.date) {
        sessions[0] = session;
    } else {
        sessions.unshift(session);
    }
    saveSessions(sessions);
    renderSessionTable();
}

function finishSession(reason) {
    // Final delta send before ending session
    if (sessionActive && sessionStartData && lastSentTime > 0) {
        const now = Date.now();
        // We don't have the very last distance here → skip final send or use last known
        // (since handleNotification already sent periodically, usually fine)
        console.log(`Session finished (${reason}) – last delta sent at ${new Date(lastSentTime).toLocaleTimeString()}`);
    }

    sessionActive = false;
    sessionStartData = null;
    lastSentDistanceMeters = 0;
    lastSentTime = 0;

    autoSaveSessionsToFile();
    showToast(`Session ${reason}. History auto-saved.`);
}

// Restore unfinished session
const restored = loadCurrentSession();
if (restored && !sessionActive) {
    sessionActive = true;
    sessionStartData = restored;
}

// --- Import/Export ---
if (exportHistoryBtn) {
    exportHistoryBtn.addEventListener('click', () => {
        const sessions = loadSessions();
        const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'treadmill_sessions.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        showToast('History exported.');
    });
}

if (importHistoryBtn && importHistoryInput) {
    importHistoryBtn.addEventListener('click', () => {
        importHistoryInput.value = '';
        importHistoryInput.click();
    });
    importHistoryInput.addEventListener('change', (e) => {
        const file = importHistoryInput.files && importHistoryInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const imported = JSON.parse(event.target.result);
                if (Array.isArray(imported)) {
                    saveSessions(imported);
                    renderSessionTable();
                    showToast('History imported successfully.');
                } else {
                    showToast('Invalid file format.');
                }
            } catch (err) {
                showToast('Failed to import: ' + err);
            }
        };
        reader.readAsText(file);
    });
}

function showToast(message, timeout = 4000) {
    if (snackbar && snackbar.MaterialSnackbar) {
        snackbar.MaterialSnackbar.showSnackbar({ message, timeout });
    } else if (snackbar) {
        snackbar.querySelector('.mdl-snackbar__text').textContent = message;
        snackbar.classList.add('mdl-snackbar--active');
        setTimeout(() => snackbar.classList.remove('mdl-snackbar--active'), timeout);
    } else {
        alert(message);
    }
}

// Auto-save every 5 minutes
setInterval(autoSaveSessionsToFile, 5 * 60 * 1000);