const WebSocket = require('ws');

// --- CONFIGURATION ---
const REMOTE_URL = 'wss://home-smart.onrender.com';
const LOCAL_URL = 'ws://localhost:3000';

// Change this to switch between testing local or remote
const WS_URL = REMOTE_URL;

console.log(`\n🚀 STARTING ESP8266 SIMULATOR v2.0`);
console.log(`🔗 Target: ${WS_URL}\n`);

const ws = new WebSocket(WS_URL);

let state = {
    switches: { switch1: 0, switch2: 0, switch3: 0, switch4: 0 },
    physical: { switch1: 1, switch4: 1 }, // Default to physical ON for safety
    system: { ledMode: 1 }
};

ws.on('open', () => {
    console.log('✅ Connected to Server');

    // 1. IDENTIFY as hardware
    const idMsg = {
        type: 'IDENTIFY',
        role: 'hardware',
        data: state
    };
    ws.send(JSON.stringify(idMsg));
    console.log('📡 Sent IDENTIFY as HARDWARE');

    // 2. Periodic Status Heartbeat
    setInterval(() => {
        const heartbeat = {
            type: 'UPDATE_STATUS',
            data: {
                switches: state.switches,
                physical: state.physical,
                rssi: Math.floor(Math.random() * -15) - 45
            }
        };
        ws.send(JSON.stringify(heartbeat));
        console.log('💓 Heartbeat Sent');
    }, 15000);
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data);

        if (msg.type === 'COMMAND') {
            const { action } = msg.data;

            if (action === 'TOGGLE') {
                const { switchId, value } = msg.data;
                console.log(`\n⚡ COMMAND RECEIVED: Turn ${switchId} ${value === 1 ? 'ON' : 'OFF'}`);

                // Simulate physical relay action
                state.switches[switchId] = value;

                // Confirm back to server
                ws.send(JSON.stringify({
                    type: 'UPDATE_STATUS',
                    data: { switches: state.switches }
                }));
                console.log(`✅ ${switchId} status updated to ${value}`);
            }

            else if (action === 'SYSTEM') {
                if (msg.data.ledMode !== undefined) {
                    state.system.ledMode = msg.data.ledMode;
                    console.log(`🌈 AURA UPDATE: Mode changed to ${state.system.ledMode}`);
                }
                if (msg.data.reboot) {
                    console.log(`🔄 REBOOT COMMAND RECEIVED! Restarting simulation...`);
                    process.exit(0);
                }
            }
        }

    } catch (e) {
        console.error('❌ Parse Error:', e);
    }
});

ws.on('close', () => {
    console.log('❌ Connection Closed. Simulation Ended.');
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('🚨 WebSocket Error:', err.message);
});

// Helper for users to simulate physical switch 1 & 4 from console
console.log('--- TO TEST PHYSICAL LOCKS ---');
console.log('In a real device, if physical switch is OFF, App cannot turn relay ON.');
console.log('------------------------------\n');
