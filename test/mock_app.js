const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
    console.log('Mock App connected');

    // Simulate user toggling a switch after 2 seconds
    setTimeout(() => {
        const toggleCommand = {
            type: 'TOGGLE_SWITCH',
            data: {
                switchId: 'switch2',
                value: 1
            }
        };
        console.log('App sending toggle command');
        ws.send(JSON.stringify(toggleCommand));
    }, 2000);

    // Simulate renaming a switch after 5 seconds
    setTimeout(() => {
        const renameCommand = {
            type: 'RENAME',
            data: {
                id: 'name2',
                newName: 'Kitchen SOCKET'
            }
        };
        console.log('App sending rename command');
        ws.send(JSON.stringify(renameCommand));
    }, 5000);
});

ws.on('message', (data) => {
    const message = JSON.parse(data);
    console.log('App received update:', message.type);
});
