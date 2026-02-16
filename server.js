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

// --- MongoDB Configuration ---
const StateSchema = new mongoose.Schema({
    id: { type: String, default: 'main_state', unique: true },
    names: {
        name1: { type: String, default: "Light" },
        name2: { type: String, default: "SOCKET" },
        name3: { type: String, default: "Tubelight" },
        name4: { type: String, default: "Fan" }
    },
    physical: {
        switch1: { type: Number, default: 0 },
        switch4: { type: Number, default: 0 }
    },
    switches: {
        switch1: { type: Number, default: 0 },
        switch2: { type: Number, default: 0 },
        switch3: { type: Number, default: 0 },
        switch4: { type: Number, default: 0 }
    },
    system: {
        ledMode: { type: Number, default: 0 },
        reboot: { type: Number, default: 0 },
        rssi: { type: Number, default: 0 }
    },
    isHardwareOnline: { type: Boolean, default: false }
});

const State = mongoose.model('State', StateSchema);

let state = {
    names: { name1: "Light", name2: "SOCKET", name3: "Tubelight", name4: "Fan" },
    physical: { switch1: 0, switch4: 0 },
    switches: { switch1: 0, switch2: 0, switch3: 0, switch4: 0 },
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
                // Merge DB state into memory state to keep isHardwareOnline: false
                Object.assign(state, dbState.toObject());
                console.log('Current state loaded from MongoDB');
            } else {
                const newState = new State();
                await newState.save();
                Object.assign(state, newState.toObject());
                console.log('Initialized new state in MongoDB');
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
