// treadmill.js - JavaScript logic for PitPat Treadmill Control Dashboard

// --- Bluetooth UUIDs ---
const SERVICE_UUID = "0000fba0-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID = "0000fba2-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID = "0000fba1-0000-1000-8000-00805f9b34fb";

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
const uploadToServerBtn = document.getElementById('uploadToServerBtn');

// --- Configuration for HTTP POST ---
const SERVER_URL = 'http://127.0.0.1:1821/';

// --- Helper function to calculate steps ---
function calculateSteps(distanceKm, speedKmh) {
    if (speedKmh <= 0) return 0;
    
    // Convert distance to meters
    const distanceMeters = distanceKm * 1000;
    
    // Calculate step length in meters using your calibrated formula
    const stepLengthMeters = 0.327 + (speedKmh - 1) * 0.0765;
    
    // Calculate steps
    const steps = distanceMeters / stepLengthMeters;
    
    return Math.floor(steps);
}

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
    if (sessions.length === 0) return; // nothing to save

    const jsonString = JSON.stringify(sessions, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;

    // Correct template literal – MUST use backticks ` ` and ${} without extra spaces or parentheses
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-'); // HH-MM-SS

    a.download = `pitpat-sessions-(${dateStr}_${timeStr}).json`;

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
    sessions.unshift(session); // newest first
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
    console.log('Rendering sessions:', sessions);
    historyTableBody.innerHTML = '';
    sessions.forEach((s, i) => {
        console.log(`Session ${i} date:`, s.date, 'type:', typeof s.date);
        let avgSpeedDisplay = '-';
        if (typeof s.avgSpeed === 'number' && !isNaN(s.avgSpeed)) {
            avgSpeedDisplay = s.avgSpeed.toFixed(2) + ' ' + (s.speedUnit || '');
        } else if (typeof s.avgSpeed === 'string' && !isNaN(parseFloat(s.avgSpeed))) {
            avgSpeedDisplay = parseFloat(s.avgSpeed).toFixed(2) + ' ' + (s.speedUnit || '');
        }
        let dateStr = '-';
        if (typeof s.date === 'number' || typeof s.date === 'string') {
            try {
                dateStr = dateFns.formatRelative(new Date(s.date), new Date());
                console.log(`Formatted date for session ${i}:`, dateStr);
            } catch (e) {
                console.error('Error formatting date:', e, 's.date =', s.date);
            }
        } else {
            console.log(`Session ${i} has invalid date:`, s.date);
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
let curTargetSpeed = 1000; // in treadmill units

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
    // Update average speed if available
    const avgSpeedDiv = document.getElementById('avgSpeed');
    if (avgSpeedDiv) {
        avgSpeedDiv.textContent = data.avgSpeed || '-';
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

// --- Send Data Logic (replaces sendCommand) ---
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
            // fallback: try to find the service by iterating
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
        // No heartbeat loop, just send heartbeat or data on notification
        if (loadingOverlay) loadingOverlay.style.display = 'none';
    } catch (err) {
        console.error("Bluetooth connection error:", err);
        showToast("Bluetooth error: " + err);
        setStatus('Disconnected');
        connected = false;
        connectBtn.textContent = "Connect";
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        // stopHeartbeatLoop();
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
    // Don't finish the session on disconnect - it can be resumed
    showToast('Disconnected - session will resume on reconnect');
}

// --- Helper to build a consistent session object for saving ---
function buildSessionObject(sd, steps, calories, avgSpeed, now) {
    return {
        date: sd.date,
        duration: sd.duration,
        steps: steps,
        distance: sd.distance,
        calories: sd.calories + ' kcal',
        avgSpeed: avgSpeed,
        speedUnit: sd.speedUnit || '',
        laps: sd.laps,
        segments: sd.segments,
        samples: sd.samples,
        speedSum: sd.speedSum,
        speedCount: sd.speedCount,
        lastUpdated: now,
        lastDistance: sd.lastDistance,
        currentLapStart: sd.currentLapStart,
        currentLapStartDistance: sd.currentLapStartDistance,
        lastSampleTime: sd.lastSampleTime || 0
    };
}

function handleNotification(event) {
    const value = event.target.value;
    // Logging for debugging
    console.log("Received notification, byteLength:", value.byteLength);
    let hexStr = [];
    for (let i = 0; i < value.byteLength; ++i) {
        hexStr.push(value.getUint8(i).toString(16).padStart(2, "0"));
    }
    console.log("Payload (hex):", hexStr.join(" "));
    // Parse treadmill data from value (see treadmill_data.py for structure)
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
        // Don't finish session on invalid data - just skip this notification
        return;
    }
    // Helper to read unsigned int from bytes
    function u16(offset) {
        return (value.getUint8(offset) << 8) | value.getUint8(offset + 1);
    }
    function u32(offset) {
        return (value.getUint8(offset) << 24) | (value.getUint8(offset + 1) << 16) | (value.getUint8(offset + 2) << 8) | value.getUint8(offset + 3);
    }
    // Parse fields
    const current_speed = u16(3);
    const distance = u32(7);
    const calories = (value.getUint8(18) << 8) | value.getUint8(19);
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
    
    const currentSpeedKmh = current_speed / 1000;
    const distanceKm = distance / 1000;
    const durationSec = Math.round(duration / 1000);
    const now = Date.now();
    
    // --- Session tracking logic with laps and segments ---
    
    // Check if we should resume an existing session
    // Don't try to resume if we just finished a session (sessionActive is false but we just set it to false)
    if (!sessionActive && durationSec > 0) {
        // There's an ongoing session on the treadmill, try to resume from localStorage
        const sessions = loadSessions();
        if (sessions.length > 0) {
            const lastSession = sessions[0];
            // Check if the last session is unfinished (has matching characteristics)
            // We consider it the same session if:
            // 1. It was updated recently (within 1 hour)
            // 2. The treadmill duration is >= the stored duration (session continued)
            // 3. The last session doesn't have a very recent lastUpdated (to prevent resume right after stop)
            const timeSinceLastUpdate = now - (lastSession.lastUpdated || lastSession.date);
            const isRecentSession = timeSinceLastUpdate < 3600000; // within 1 hour
            const notJustFinished = timeSinceLastUpdate > 5000; // at least 5 seconds since last update
            const isSameSession = durationSec >= (lastSession.duration || 0);
            
            if (isRecentSession && notJustFinished && isSameSession) {
                // Resume the session
                sessionActive = true;
                sessionStartData = {
                    date: lastSession.date,
                    steps: lastSession.steps,
                    calories: lastSession.calories,
                    distance: lastSession.distance,
                    duration: lastSession.duration,
                    speedSum: lastSession.speedSum || (lastSession.avgSpeed * (lastSession.speedCount || 1) * 1000),
                    speedCount: lastSession.speedCount || 1,
                    speedUnit: speed_unit,
                    laps: lastSession.laps || [],
                    segments: lastSession.segments || [],
                    samples: lastSession.samples || [],
                    currentLapStart: lastSession.currentLapStart || now,
                    currentLapStartDistance: lastSession.currentLapStartDistance || lastSession.distance,
                    currentSegmentStart: now,
                    lastState: running_state,
                    lastRecordedSpeed: 0,       // ← Reset so first real speed after reconnect triggers a sample
                    lastDistance: lastSession.lastDistance || lastSession.distance,
                    lastSampleTime: lastSession.lastSampleTime || now  // ← Restore or use now to avoid immediate fire
                };
                
                // If we're running, ensure we have an active segment
                if (running_state === 1) {
                    // Check if last segment needs to be closed
                    if (sessionStartData.segments.length > 0) {
                        const lastSegment = sessionStartData.segments[sessionStartData.segments.length - 1];
                        if (lastSegment.endTime === null && lastSegment.segmentType === 39) {
                            // Close pause segment
                            lastSegment.endTime = now;
                        }
                    }
                    // Add new active segment if needed
                    if (sessionStartData.segments.length === 0 || 
                        sessionStartData.segments[sessionStartData.segments.length - 1].segmentType !== 47) {
                        sessionStartData.segments.push({
                            startTime: now,
                            endTime: null,
                            segmentType: 47, // active
                            repetitions: 1
                        });
                    }
                }
                
                showToast('Resumed ongoing session');
                console.log('Resumed session from localStorage');
            }
        }
    }
    
    if (running_state === 1 && !sessionActive) {
        // Session started
        sessionActive = true;
        sessionStartData = {
            date: now,
            steps: 0,
            calories: calories,
            distance: distance,
            duration: durationSec,
            speedSum: current_speed,
            speedCount: 1,
            speedUnit: speed_unit,
            laps: [],
            segments: [],
            samples: [],
            currentLapStart: now,
            currentLapStartDistance: distance,
            currentSegmentStart: now,
            lastState: 1,
            lastRecordedSpeed: 0,       // ← Set to 0 so first real speed triggers speedChanged
            lastSampleTime: now,        // ← Set to now so interval doesn't fire immediately
            lastDistance: distance
        };
        
        // Start first segment (active)
        sessionStartData.segments.push({
            startTime: now,
            endTime: null,
            segmentType: 47, // active
            repetitions: 1
        });
        
        // Save initial session
        const avgSpeed = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        upsertLiveSession(buildSessionObject(sessionStartData, 0, calories, avgSpeed, now));
    }
    
    // Update speed stats FIRST (before calculating steps)
    if (running_state === 1 && sessionActive && sessionStartData) {
        sessionStartData.speedSum += current_speed;
        sessionStartData.speedCount += 1;
        
        // Record speed sample every 5 minutes OR on speed change, never 0
        const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
        const lastSampleTime = sessionStartData.lastSampleTime || 0;
        const speedChanged = current_speed !== sessionStartData.lastRecordedSpeed;
        const intervalElapsed = now - lastSampleTime >= SAMPLE_INTERVAL_MS;
        if ((speedChanged || intervalElapsed) && current_speed > 0) {
            sessionStartData.samples.push({
                time: now,
                speed: {
                    value: current_speed / 1000,
                    type: speed_unit === 'mph' ? 'MILES_PER_HOUR' : 'KILOMETERS_PER_HOUR'
                }
            });
            sessionStartData.lastSampleTime = now;
        }
        
        // If we just resumed from pause, close pause segment and start active segment
        if (sessionStartData.lastState === 2) {
            // Close pause segment
            if (sessionStartData.segments.length > 0) {
                const lastSegment = sessionStartData.segments[sessionStartData.segments.length - 1];
                if (lastSegment.endTime === null) {
                    lastSegment.endTime = now;
                }
            }
            
            // Start new active segment
            sessionStartData.segments.push({
                startTime: now,
                endTime: null,
                segmentType: 47, // active
                repetitions: 1
            });
            
            // Start new lap - use current distance as start point
            sessionStartData.currentLapStart = now;
            sessionStartData.currentLapStartDistance = distance;
        }
        
        sessionStartData.lastState = 1;
    }
    
    // Always track last known non-zero speed regardless of state
    if (current_speed > 0 && sessionActive && sessionStartData) {
        sessionStartData.lastRecordedSpeed = current_speed;
    }
    
    // Calculate steps INCREMENTALLY using distance delta
    let calculatedSteps = 0;
    if (sessionActive && sessionStartData) {
        // Check if treadmill distance went backwards (reset)
        if (distance < sessionStartData.lastDistance) {
            console.log('Treadmill distance reset detected, resetting lastDistance to 0');
            sessionStartData.lastDistance = 0;
            sessionStartData.steps = 0; // Reset steps too
        }
        
        // Calculate distance delta since last update
        const deltaDistance = distance - sessionStartData.lastDistance;
        
        if (deltaDistance > 0) {
            // Determine which speed to use based on delta size
            // Small delta (< 50m) = normal operation, use current speed
            // Large delta (>= 50m) = reconnection or long gap, use average speed
            const RECONNECTION_THRESHOLD = 50; // meters
            let speedForSteps;
            
            if (deltaDistance < RECONNECTION_THRESHOLD) {
                // Normal operation - use current instantaneous speed
                speedForSteps = current_speed / 1000;
                console.log(`Small delta (${deltaDistance}m): using current speed ${speedForSteps.toFixed(2)} kph`);
            } else {
                // Reconnection or large gap - use average speed
                speedForSteps = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
                console.log(`Large delta (${deltaDistance}m): using average speed ${speedForSteps.toFixed(2)} kph`);
            }
            
            // Calculate stride length based on chosen speed
            const stepLengthMeters = 0.327 + (speedForSteps - 1) * 0.0765;
            
            // Calculate steps for the delta distance
            const deltaSteps = Math.floor(deltaDistance / stepLengthMeters);
            
            // Add to accumulated steps
            sessionStartData.steps += deltaSteps;
            sessionStartData.lastDistance = distance;
            
            console.log(`Delta: ${deltaDistance}m, Speed: ${speedForSteps.toFixed(2)} kph, Stride: ${stepLengthMeters.toFixed(3)}m, Delta steps: ${deltaSteps}, Total steps: ${sessionStartData.steps}`);
        }
        
        calculatedSteps = sessionStartData.steps;
    } else {
        // No active session, calculate from scratch (for display purposes)
        const distanceKm = distance / 1000;
        const speedForSteps = currentSpeedKmh;
        calculatedSteps = calculateSteps(distanceKm, speedForSteps);
    }
    
    // Create treadmillData object
    let avgSpeedDisplay = '-';
    if (sessionActive && sessionStartData && sessionStartData.speedCount > 0) {
        const avgSpeedKmh = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        avgSpeedDisplay = avgSpeedKmh.toFixed(2) + " " + speed_unit;
    }
    
    treadmillData = {
        speed: currentSpeedKmh.toFixed(2) + " " + speed_unit,
        distance: distanceKm.toFixed(2) + " " + distance_unit,
        calories: calories + " kcal",
        steps: calculatedSteps,
        duration: durationSec,
        avgSpeed: avgSpeedDisplay,
        status: statusArr[running_state] || "Unknown",
        _raw: { current_speed, distance, calories, steps: calculatedSteps, duration, speed_unit }
    };
    
    // Log parsed fields
    console.log("Parsed treadmill data:", treadmillData);
    updateDashboard(treadmillData);
    updateRunningState(running_state);
    
    // Continue with session updates
    if (running_state === 1 && sessionActive && sessionStartData) {
        // Update session data
        sessionStartData.steps = calculatedSteps;
        sessionStartData.calories = calories;
        sessionStartData.distance = distance;
        sessionStartData.duration = durationSec;
        
        // Update live session
        const avgSpeed = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        upsertLiveSession(buildSessionObject(sessionStartData, calculatedSteps, calories, avgSpeed, now));
        
    } else if (running_state === 2 && sessionActive && sessionStartData) {
        // Paused - close current lap and active segment, start pause segment
        if (sessionStartData.lastState === 1) {
            // Close current lap
            const lapDistance = distance - sessionStartData.currentLapStartDistance;
            sessionStartData.laps.push({
                startTime: sessionStartData.currentLapStart,
                endTime: now,
                length: {
                    value: lapDistance,
                    type: "METERS"
                }
            });
            
            // Close active segment
            if (sessionStartData.segments.length > 0) {
                const lastSegment = sessionStartData.segments[sessionStartData.segments.length - 1];
                if (lastSegment.endTime === null) {
                    lastSegment.endTime = now;
                }
            }
            
            // Start pause segment
            sessionStartData.segments.push({
                startTime: now,
                endTime: null,
                segmentType: 39, // pause
                repetitions: 1
            });
        }
        
        sessionStartData.lastState = 2;
        
        // Update live session
        const avgSpeed = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        upsertLiveSession(buildSessionObject(sessionStartData, calculatedSteps, calories, avgSpeed, now));
        
    } else if (running_state === 3 && sessionActive && sessionStartData) {
        // Stopped - finalize session
        if (sessionStartData.lastState === 1) {
            // Close final lap if we were running
            const lapDistance = distance - sessionStartData.currentLapStartDistance;
            sessionStartData.laps.push({
                startTime: sessionStartData.currentLapStart,
                endTime: now,
                length: {
                    value: lapDistance,
                    type: "METERS"
                }
            });
        }
        
        // Close final segment (whether active or pause)
        if (sessionStartData.segments.length > 0) {
            const lastSegment = sessionStartData.segments[sessionStartData.segments.length - 1];
            if (lastSegment.endTime === null) {
                lastSegment.endTime = now;
            }
        }
        
        // Record final speed sample - always use last KNOWN non-zero speed
        // (treadmill reports current_speed=0 on stop, which is not useful)
        const finalSpeed = current_speed > 0 ? current_speed : sessionStartData.lastRecordedSpeed;
        if (finalSpeed > 0) {
            sessionStartData.samples.push({
                time: now,
                speed: {
                    value: finalSpeed / 1000,
                    type: speed_unit === 'mph' ? 'MILES_PER_HOUR' : 'KILOMETERS_PER_HOUR'
                }
            });
        }
        
        // Update final session stats before finishing
        // IMPORTANT: Only update duration/calories if treadmill reports non-zero,
        // otherwise keep the last known values (treadmill resets them to 0 on stop)
        sessionStartData.steps = calculatedSteps;
        if (calories > 0) {
            sessionStartData.calories = calories;
        }
        sessionStartData.distance = distance;
        if (durationSec > 0) {
            sessionStartData.duration = durationSec;
        }
        
        // Save final state
        const avgSpeed = (sessionStartData.speedSum / sessionStartData.speedCount) / 1000;
        upsertLiveSession(buildSessionObject(sessionStartData, calculatedSteps, calories, avgSpeed, now));
        
        finishSession('Stopped');
    }

    // --- Heartbeat/data send logic, like _notification_handler ---
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
            // Heartbeat packet: 6a05fdf843
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

// --- Command Packet Generators (see treadmill_controller.py) ---
/**
 * Constructs a treadmill command packet.
 * @param {string} type - Command type: "start", "pause", "stop", or "set_speed".
 * @param {number} [speed=1000] - Target speed in treadmill units (integer, 1000 = 1.00 kph, range: 1000 to 6000).
 * @returns {Uint8Array} The command packet.
 */
function makePacket(type, speed = 1000) {
    // type: "start", "pause", "stop", "set_speed"
    // Implements the protocol from treadmill_controller.py
    let arr = new Uint8Array(23);
    arr[0] = 0x6A; // START_BYTE
    arr[1] = 0x17; // LENGTH
    // arr[2-5] = 0 (reserved)
    arr[6] = (speed >> 8) & 0xFF;
    arr[7] = speed & 0xFF;
    arr[8] = type === "set_speed" ? 5 : 1; // magical_i11: 5 for set_speed, 1 for others
    arr[9] = 0; // incline
    arr[10] = 80; // weight (default)
    arr[11] = 0; // reserved
    // Command byte (kph): 4=start/set, 2=pause, 0=stop
    let cmd = type === "pause" ? 2 : type === "stop" ? 0 : 4;
    arr[12] = cmd & 0xF7; // kph mode (bit 3 = 0)
    // User ID (8 bytes, default 58965456623)
    let userId = 58965456623n;
    for (let i = 0; i < 8; ++i) {
        arr[13 + i] = Number((userId >> BigInt(56 - i * 8)) & 0xFFn);
    }
    // Checksum: XOR of bytes 1 to 20
    let checksum = 0;
    for (let i = 1; i <= 20; ++i) {
        checksum ^= arr[i];
    }
    arr[21] = checksum;
    arr[22] = 0x43; // END_BYTE
    return arr;
}

// --- HTTP POST Function ---
/**
 * Sends session data to a server via HTTP POST
 * @param {Object} sessionData - The session data to upload
 * @returns {Promise<Object>} Response from the server
 */
async function uploadSessionToServer(sessionData) {
    try {
        showToast('Uploading session to server...');
        
        const response = await fetch(SERVER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(sessionData)
        });

        const result = await response.text();
        
        if (result.trim() !== 'OK') {
            throw new Error(`Unexpected response: ${result}`);
        }
        
        showToast('Session uploaded successfully!');
        return result;
    } catch (error) {
        showToast('Upload failed: ' + error.message, 5000);
        throw error;
    }
}
/**
 * Upload all sessions to server
 */
async function uploadAllSessionsToServer() {
    const sessions = loadSessions();
    
    if (sessions.length === 0) {
        showToast('No sessions to upload');
        return;
    }

    try {
        const payload = {
            sessions: sessions,
            uploadDate: new Date().toISOString(),
            deviceInfo: {
                userAgent: navigator.userAgent,
                platform: navigator.platform
            }
        };

        await uploadSessionToServer(payload);
    } catch (error) {
        // Error already handled in uploadSessionToServer
    }
}

// --- UI Event Handlers ---
connectBtn.addEventListener('click', () => {
    if (!connected) connectBluetooth();
    else disconnectBluetooth();
});

startBtn.addEventListener('click', async () => {
    if (!connected) return;
    if (runningState === 1) { // Running -> Pause
        send_data(makePacket("pause"));
    } else { // Start
        // Show countdown overlay (visual only, do not delay command)
        if (countdownOverlay && countdownNumber) {
            countdownOverlay.style.display = 'flex';
            countdownOverlay.style.opacity = '1';
            let count = 3;
            countdownNumber.textContent = count;
            countdownNumber.style.opacity = '1';
            countdownNumber.style.transform = 'scale(1)';
            // Animate countdown in background
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
                await new Promise(res => setTimeout(res, 500)); // Wait for fade-out
                countdownOverlay.style.display = 'none';
                countdownOverlay.style.opacity = '1'; // Reset for next time
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
    curTargetSpeed = Math.min(curTargetSpeed + 500, 6000);
    send_data(makePacket("set_speed", curTargetSpeed));
});

speedDownBtn.addEventListener('click', () => {
    if (!connected) return;
    curTargetSpeed = Math.max(curTargetSpeed - 500, 1000);
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

// --- Upload to Server Button Handler ---
if (uploadToServerBtn) {
    uploadToServerBtn.addEventListener('click', async () => {
        await uploadAllSessionsToServer();
    });
}

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
    // Debug: log the session being saved
    console.log('Upserting session with date:', session.date, 'Full session:', session);
    
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
    sessionActive = false;
    sessionStartData = null;
    // No need to do anything else, as the session is already up-to-date in treadmill_sessions
    
    // NEW: Auto-download the full history as JSON
    //autoSaveSessionsToFile();
    
    showToast(`Session ${reason}. History auto-saved.`);
}

// On page load, check for an unfinished session and restore it if present
const restored = loadCurrentSession();
if (restored && !sessionActive) {
    sessionActive = true;
    sessionStartData = restored;
}

// --- Import/Export History ---
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
        // fallback for late upgrade
        snackbar.querySelector('.mdl-snackbar__text').textContent = message;
        snackbar.classList.add('mdl-snackbar--active');
        setTimeout(() => snackbar.classList.remove('mdl-snackbar--active'), timeout);
    } else {
        alert(message); // fallback
    }
}

// Tasker upload button
const uploadToTaskerBtn = document.getElementById('uploadToTaskerBtn');
if (uploadToTaskerBtn) {
    uploadToTaskerBtn.onclick = () => {
        window.location.href = 'tasker://assistantactions?task=PitPat_Upload_Steps';
    };
}
