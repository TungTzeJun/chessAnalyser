const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 8080;
const STOCKFISH_PATH = path.join(__dirname, 'stockfish', 'stockfish', 'stockfish-windows-x86-64-avx2.exe');

// Verify Stockfish exists
if (!fs.existsSync(STOCKFISH_PATH)) {
    console.error(`Stockfish executable not found at: ${STOCKFISH_PATH}`);
    process.exit(1);
}

const wss = new WebSocket.Server({ port: PORT });

console.log(`Chess Analyzer Backend running on ws://localhost:${PORT}`);
console.log(`Using Stockfish at: ${STOCKFISH_PATH}`);

wss.on('connection', (ws) => {
    console.log('Client connected');

    // Spawn Stockfish process for this client
    let engine;
    try {
        engine = spawn(STOCKFISH_PATH);
    } catch (err) {
        console.error('Failed to spawn Stockfish:', err);
        ws.close();
        return;
    }

    engine.on('error', (err) => {
        console.error('Stockfish process error:', err);
        ws.send('error: ' + err.message);
    });

    engine.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (line.trim()) {
                ws.send(line.trim());
            }
        }
    });

    engine.stderr.on('data', (data) => {
        console.error(`Stockfish Error: ${data}`);
    });

    engine.on('close', (code) => {
        console.log(`Stockfish process exited with code ${code}`);
    });

    ws.on('message', (message) => {
        const command = message.toString();
        // console.log(`Command: ${command}`); // Optional logging
        if (engine && engine.stdin.writable) {
            engine.stdin.write(command + '\n');
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (engine) {
            engine.kill();
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        if (engine) {
            engine.kill();
        }
    });
});
