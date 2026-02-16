require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// --- MongoDB Configuration (Names Persistence Only) ---
const StateSchema = new mongoose.Schema({
    id: { type: String, default: 'main_state', unique: true },
    names: {
        name1: { type: String, default: "Light" },
        name2: { type: String, default: "SOCKET" },
        name3: { type: String, default: "Tubelight" },
        name4: { type: String, default: "Fan" }
    }
});

const State = mongoose.model('State', StateSchema);

// Memory State (Transient Core)
let state = {
    names: { name1: "Light", name2: "SOCKET", name3: "Tubelight", name4: "Fan" },
    physical: { switch1: 0, switch4: 0 },
    switches: { switch1: 0, switch2: 0, switch3: 0, switch4: 0 },
    schedules: {
        switch1: { active: false, time: "00:00", action: 1 },
        switch2: { active: false, time: "00:00", action: 1 },
        switch3: { active: false, time: "00:00", action: 1 },
        switch4: { active: false, time: "00:00", action: 1 }
    },
    timers: {
        switch1: { active: false, endAt: 0, action: 0 },
        switch2: { active: false, endAt: 0, action: 0 },
        switch3: { active: false, endAt: 0, action: 0 },
        switch4: { active: false, endAt: 0, action: 0 }
    },
    system: { ledMode: 0, reboot: 0, rssi: 0 },
    isHardwareOnline: false
};

// Connect to MongoDB
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(async () => {
            console.log('Connected to MongoDB Atlas');
            const dbState = await State.findOne({ id: 'main_state' });
            if (dbState) {
                // Restore ONLY names from DB. Everything else is transient memory.
                Object.assign(state.names, dbState.names);
                console.log('Persisted names loaded from MongoDB');
            } else {
                const newState = new State();
                await newState.save();
                console.log('Initialized new name registry in MongoDB');
            }
        })
        .catch(err => console.error('MongoDB connection error:', err));
}

// Helper to save state (updates both RAM and DB)
async function updateAndSave(updates, shouldPersist = false) {
    // Merge updates into our local state object
    // Mongoose handles deep updates well if we use .set or structured updates
    if (updates.switches) Object.assign(state.switches, updates.switches);
    if (updates.physical) Object.assign(state.physical, updates.physical);
    if (updates.names) Object.assign(state.names, updates.names);
    if (updates.system) Object.assign(state.system, updates.system);

    // Only save to MongoDB if requested (primarily for name changes)
    if (MONGODB_URI && shouldPersist) {
        state.markModified('names');
        // Only saving the names object specifically
        await state.save();
        console.log('Names persisted to MongoDB');
    }
}

// --- Middleware ---
app.use(express.json());
app.use(express.static('public'));

// --- WebSocket Broadcast ---
function broadcast(data, excludeWs = null) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// --- AUTOMATION ENGINE (IST) ---
let preNightLedMode = 1; // Default to Breathing if never set

setInterval(async () => {
    const now = new Date();
    // Calculate IST (UTC + 5:30)
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);

    const hours = istTime.getUTCHours();
    const minutes = istTime.getUTCMinutes();

    // 1. Aura Night Protocol (22:30 / 10:30 PM)
    // Window: 10:30 PM to 4:59 AM
    const isNightTime = (hours > 22 || (hours === 22 && minutes >= 30)) || (hours < 5);

    if (isNightTime) {
        // If Relay 1 is OFF, turn Aura OFF
        if (state.switches.switch1 === 0 && state.system.ledMode !== 0) {
            console.log('--- AUTO-AUTOMATION: It is late and Light is OFF. Disabling Aura. ---');
            preNightLedMode = state.system.ledMode; // Store for morning
            await updateAndSave({ system: { ledMode: 0 } }, false);
            broadcast({ type: 'STATE_CHANGED', data: state });
            broadcast({ type: 'COMMAND', data: { action: 'SYSTEM', ledMode: 0 } });
        }
    }
    // 2. Aura Morning Restore (05:00 AM)
    else if (hours === 5 && minutes === 0) {
        if (state.system.ledMode === 0) {
            console.log(`--- AUTO-AUTOMATION: 5:00 AM IST. Restoring Aura to Mode ${preNightLedMode}. ---`);
            await updateAndSave({ system: { ledMode: preNightLedMode } }, false);
            broadcast({ type: 'STATE_CHANGED', data: state });
            broadcast({ type: 'COMMAND', data: { action: 'SYSTEM', ledMode: preNightLedMode } });
        }
    }

    // 3. Precision Schedule/Timer Trigger (Double Protection)
    // Checks if any task is due in the next 60 seconds.
    // We send a "Pre-Trigger" command to the hardware.
    for (let i = 1; i <= 4; i++) {
        const switchId = `switch${i}`;

        // Check Schedule
        const sched = state.schedules[switchId];
        if (sched && sched.active) {
            const [sHour, sMin] = sched.time.split(':').map(Number);
            if (hours === sHour && minutes === sMin) {
                console.log(`[Double-Protection] Schedule hit for ${switchId}. Sending reminder.`);
                broadcast({ type: 'COMMAND', data: { action: 'TOGGLE', switchId, value: sched.action } });
            }
        }

        // Check Timer
        const timer = state.timers[switchId];
        if (timer && timer.active) {
            const timeLeft = Math.floor((timer.endAt - istTime.getTime()) / 1000);
            if (timeLeft <= 30 && timeLeft > -30) { // Within 30s window
                console.log(`[Double-Protection] Timer hit for ${switchId}. Sending reminder.`);
                broadcast({ type: 'COMMAND', data: { action: 'TOGGLE', switchId, value: timer.action } });
                // Clean up timer after trigger
                state.timers[switchId].active = false;
                broadcast({ type: 'STATE_CHANGED', data: state });
            }
        }
    }

    // 4. STAY-AWAKE PROTOCOL (23-Hour Active)
    // Prevents Render spin-down except during the hardware's deep sleep window (2:30 AM - 3:30 AM IST)
    const isSleepWindow = (hours === 2 && minutes >= 30) || (hours === 3 && minutes < 30);
    if (!isSleepWindow && minutes % 10 === 0) {
        const https = require('https');
        const selfUrl = process.env.SELF_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}.onrender.com/ping`;
        if (selfUrl.startsWith('https')) {
            https.get(selfUrl, (res) => {
                console.log(`[System] Self-Ping: Active Mode (${res.statusCode})`);
            }).on('error', (e) => { /* ignore */ });
        }
    }
}, 60000); // Check every minute

// --- WebSocket connection handling ---
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`New connection from ${ip}`);
    ws.role = 'app'; // Default

    // Initial sync
    ws.send(JSON.stringify({ type: 'FULL_STATE', data: state }));

    ws.on('message', async (message) => {
        try {
            const payload = JSON.parse(message);
            console.log('Received message:', payload);

            if (payload.type === 'IDENTIFY') {
                if (payload.role === 'hardware') {
                    ws.role = 'hardware';
                    state.isHardwareOnline = true;
                    console.log('--- HW DEVICE LINKED ---');

                    // Initial HW Sync
                    const updates = {};
                    if (payload.data.switches) updates.switches = payload.data.switches;
                    if (payload.data.physical) updates.physical = payload.data.physical;
                    if (payload.data.system) updates.system = payload.data.system;

                    await updateAndSave(updates, false);
                    broadcast({ type: 'STATE_CHANGED', data: state });
                }
            }
            else if (payload.type === 'UPDATE_STATUS') {
                // Sent by ESP8266 (Surgical or Periodic)
                const updates = {};
                if (payload.data.switches) updates.switches = payload.data.switches;
                if (payload.data.physical) updates.physical = payload.data.physical;

                await updateAndSave(updates, false);
                broadcast({ type: 'STATE_CHANGED', data: state }, ws);
            }
            else if (payload.type === 'TOGGLE_SWITCH') {
                const { switchId, value } = payload.data;

                // --- ARMOR PLATING: Reject if Hardware is Offline ---
                if (!state.isHardwareOnline) {
                    console.log(`REJECTED: App tried to toggle ${switchId} but HW is OFFLINE.`);
                    ws.send(JSON.stringify({
                        type: 'ERROR',
                        message: 'Hardware Offline - Command Delayed'
                    }));
                    ws.send(JSON.stringify({ type: 'STATE_CHANGED', data: state }));
                    return;
                }

                const switches = { ...state.switches };

                // --- SUPERIOR SWITCH LOGIC (1 & 4) ---
                if ((switchId === 'switch1' || switchId === 'switch4') && value === 1) {
                    const physicalStatus = state.physical[switchId];
                    if (physicalStatus === 0) {
                        console.log(`REJECTED: Cannot turn ${switchId} ON because physical switch is OFF.`);
                        // Force App state back to OFF
                        ws.send(JSON.stringify({ type: 'STATE_CHANGED', data: state }));
                        return; // Exit early, do not broadcast command
                    }
                }

                if (switches.hasOwnProperty(switchId)) {
                    switches[switchId] = value;
                    await updateAndSave({ switches }, false); // Toggle is transient until ESP confirms it

                    broadcast({ type: 'COMMAND', data: { action: 'TOGGLE', switchId, value } });
                    broadcast({ type: 'STATE_CHANGED', data: state });
                }
            }
            else if (payload.type === 'SET_SCHEDULE') {
                const { switchId, active, time, action } = payload.data;
                console.log(`[Schedule] Setting ${switchId} to ${action === 1 ? 'ON' : 'OFF'} at ${time}`);

                state.schedules[switchId] = { active, time, action };

                // 1. Update all Apps
                broadcast({ type: 'STATE_CHANGED', data: state });

                // 2. Sync with Hardware (Offline Protection)
                broadcast({ type: 'COMMAND', data: { action: 'SYNC_SCHED', switchId, active, time, action } });
            }
            else if (payload.type === 'SET_TIMER') {
                const { switchId, active, duration, action } = payload.data;
                console.log(`[Timer] Setting ${switchId} for ${duration}s -> ${action === 1 ? 'ON' : 'OFF'}`);

                // Calculate End Time in IST (Now + Duration)
                // Note: endAt is a timestamp, independent of Timezone logic, but we treat it as UTC+5:30 reference
                const endAt = Date.now() + (duration * 1000);

                state.timers[switchId] = { active, endAt, action };

                // 1. Update all Apps
                broadcast({ type: 'STATE_CHANGED', data: state });

                // 2. Sync with Hardware (Offline Protection)
                broadcast({ type: 'COMMAND', data: { action: 'SYNC_TIMER', switchId, active, duration, action } });
            }
            else if (payload.type === 'DELETE_TASK') {
                const { switchId, taskType } = payload.data;
                console.log(`[Delete] Removing ${taskType} for ${switchId}`);

                if (taskType === 'schedule') {
                    state.schedules[switchId] = { active: false, time: null, action: null };
                    broadcast({ type: 'COMMAND', data: { action: 'SYNC_SCHED', switchId, active: false } });
                } else if (taskType === 'timer') {
                    state.timers[switchId] = { active: false, endAt: null, action: null };
                    broadcast({ type: 'COMMAND', data: { action: 'SYNC_TIMER', switchId, active: false } });
                }
                broadcast({ type: 'STATE_CHANGED', data: state });
            }
            else if (payload.type === 'RENAME') {
                const { id, newName } = payload.data;
                const names = { ...state.names };
                if (names.hasOwnProperty(id)) {
                    names[id] = newName;
                    await updateAndSave({ names }, true); // PERSIST NAMES
                    broadcast({ type: 'STATE_CHANGED', data: state });
                }
            }
            else if (payload.type === 'SYSTEM_UPDATE') {
                // --- ARMOR PLATING: Reject if Hardware is Offline ---
                if (!state.isHardwareOnline) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Hardware Offline' }));
                    ws.send(JSON.stringify({ type: 'STATE_CHANGED', data: state }));
                    return;
                }
                await updateAndSave({ system: payload.data }, false); // Transients (ledMode, reboot)
                broadcast({ type: 'COMMAND', data: { action: 'SYSTEM', ...payload.data } });
                broadcast({ type: 'STATE_CHANGED', data: state });
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        if (ws.role === 'hardware') {
            console.log('--- HW DEVICE DISCONNECTED ---');
            state.isHardwareOnline = false;
            broadcast({ type: 'STATE_CHANGED', data: state });
        }
    });
});

// --- REST API ---
app.get('/ping', (req, res) => res.send('PONG - System Active')); // Wake-up endpoint
app.get('/api/state', (req, res) => res.json(state));

app.post('/api/toggle', async (req, res) => {
    const { switchId, value } = req.body;

    // --- SUPERIOR SWITCH LOGIC (1 & 4) ---
    if ((switchId === 'switch1' || switchId === 'switch4') && value === 1) {
        const physicalStatus = state.physical[switchId];
        if (physicalStatus === 0) {
            console.log(`API REJECTED: Cannot turn ${switchId} ON because physical switch is OFF.`);
            return res.status(403).json({ success: false, error: 'Physical switch is OFF', state });
        }
    }

    if (state.switches.hasOwnProperty(switchId)) {
        const switches = { ...state.switches };
        switches[switchId] = value;
        await updateAndSave({ switches }, false);

        broadcast({ type: 'COMMAND', data: { action: 'TOGGLE', switchId, value } });
        broadcast({ type: 'STATE_CHANGED', data: state });
        res.json({ success: true, state });
    } else {
        res.status(400).json({ success: false, error: 'Invalid switch ID' });
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
