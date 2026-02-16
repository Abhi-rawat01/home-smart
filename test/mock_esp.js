const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
    console.log('Mock ESP connected');

    // Simulate periodic status updates
    setInterval(() => {
        const statusUpdate = {
            type: 'UPDATE_STATUS',
            data: {
                system: {
                    rssi: Math.floor(Math.random() * -20) - 40,
                    lastSeen: Date.now()
                },
                switches: {
                    switch1: Math.random() > 0.5 ? 1 : 0
                }
            }
        };
        console.log('ESP sending status update');
        ws.send(JSON.stringify(statusUpdate));
    }, 10000);
});

ws.on('message', (data) => {
    const message = JSON.parse(data);
    console.log('ESP received message:', message);

    if (message.type === 'COMMAND' && message.data.action === 'TOGGLE') {
        console.log(`ESP toggling ${message.data.switchId} to ${message.data.value}`);
    }
});
