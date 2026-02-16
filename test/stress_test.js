const WebSocket = require('ws');

// --- CONFIGURATION ---
const WS_URL = 'ws://localhost:3000'; // Target the local Node.js server
const TOTAL_COMMANDS = 1000;
const BURST_SIZE = 50;

async function runBruteTest() {
    console.log('🚀 INITIALIZING STRESS TEST ON X-CORE BACKEND');

    const socket = new WebSocket(WS_URL);

    socket.on('open', async () => {
        console.log('✅ Connected to Server. Starting Brute Command Injection...');

        const startTime = Date.now();
        let successCount = 0;

        for (let i = 0; i < TOTAL_COMMANDS; i++) {
            const switchId = `switch${(i % 4) + 1}`;
            const value = (i % 2); // Rotate ON/OFF

            const payload = JSON.stringify({
                type: 'TOGGLE_SWITCH',
                data: { switchId, value }
            });

            socket.send(payload);
            successCount++;

            // Stress the event loop in bursts
            if (i % BURST_SIZE === 0) {
                await new Promise(r => setTimeout(r, 10)); // Tiny gap for server to breathe
            }
        }

        const duration = Date.now() - startTime;
        console.log('\n--- TEST COMPLETE ---');
        console.log(`📊 Sent: ${successCount} commands`);
        console.log(`⏱️ Duration: ${duration}ms`);
        console.log(`⚡ Rate: ${(successCount / (duration / 1000)).toFixed(2)} commands/sec`);

        socket.close();
    });

    socket.on('error', (err) => {
        console.error('❌ Connection Error during test:', err.message);
    });
}

runBruteTest();
