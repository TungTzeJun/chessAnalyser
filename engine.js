document.addEventListener('DOMContentLoaded', function () {
    const input = document.getElementById('pgnInput');
    const button = document.getElementById('importPgn');
    const message = document.getElementById('pgnMessage');
    const metadataCard = document.getElementById('metadata');
    const metaWhite = document.getElementById('metaWhite');
    const metaBlack = document.getElementById('metaBlack');
    const metaResult = document.getElementById('metaResult');
    const metaEvent = document.getElementById('metaEvent');
    const metaDate = document.getElementById('metaDate');
    const evalCanvas = document.getElementById('evalCanvas');
    const boardSection = document.getElementById('boardSection');
    const boardEl = document.getElementById('board');
    const evalBar = document.getElementById('evalBar');
    const evalFill = document.getElementById('evalFill');
    const evalLabel = document.getElementById('evalLabel');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const pvList = document.getElementById('pvList');
    const pvInfo = document.getElementById('pvInfo');
    const pvPrev = document.getElementById('pvPrev');
    const pvNext = document.getElementById('pvNext');
    const pvReset = document.getElementById('pvReset');
    const firstBtn = document.getElementById('firstMove');
    const prevBtn = document.getElementById('prevMove');
    const nextBtn = document.getElementById('nextMove');
    const lastBtn = document.getElementById('lastMove');
    const moveStatus = document.getElementById('moveStatus');
    if (!input || !button) return;

    function cleanPGN(pgn) {
        return (pgn || '')
            .replace(/\[[\s\S]*?\]/g, '')
            .replace(/\{[\s\S]*?\}/g, '')
            .replace(/\([\s\S]*?\)/g, '')
            .replace(/\d+\.(\.\.)?/g, '')
            .replace(/\b(1-0|0-1|1\/2-1\/2)\b/g, '')
            .trim();
    }

    function parseHeaders(pgn) {
        const headers = {};
        const re = /\[(\w+)\s+"([^"]*)"\]/g;
        let m;
        while ((m = re.exec(pgn)) !== null) {
            headers[m[1]] = m[2];
        }
        return headers;
    }

    function extractMoves(pgn) {
        const cleaned = cleanPGN(pgn);
        return cleaned.split(/\s+/).filter(Boolean);
    }

    function extractEvalSeries(pgn) {
        const series = [];
        const reBracket = /\[%eval\s+([^\]]+)\]/gi;
        const reBare = /%eval\s+([^\s}]+)/gi;
        let m;
        while ((m = reBracket.exec(pgn)) !== null) {
            const v = String(m[1]).trim();
            if (/^#-?\d+$/i.test(v)) {
                const sign = v.includes('-') ? -1 : 1;
                series.push(99 * sign);
            } else {
                const n = parseFloat(v);
                if (!isNaN(n)) series.push(n);
            }
        }
        while ((m = reBare.exec(pgn)) !== null) {
            const v = String(m[1]).trim();
            if (/^#-?\d+$/i.test(v)) {
                const sign = v.includes('-') ? -1 : 1;
                series.push(99 * sign);
            } else {
                const n = parseFloat(v);
                if (!isNaN(n)) series.push(n);
            }
        }
        return series;
    }


    function drawEval(series, pointer) {
        if (!evalCanvas) return;
        const ctx = evalCanvas.getContext('2d');
        ctx.clearRect(0, 0, evalCanvas.width, evalCanvas.height);
        const w = evalCanvas.width;
        const h = evalCanvas.height;
        const mid = Math.floor(h / 2);
        ctx.strokeStyle = '#1f2937';
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();
        if (!series || series.length === 0) return;
        const min = Math.min(...series);
        const max = Math.max(...series);
        const span = Math.max(0.5, Math.max(Math.abs(min), Math.abs(max)));
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < series.length; i++) {
            const x = Math.floor((i / Math.max(1, series.length - 1)) * w);
            const y = mid - Math.floor((series[i] / span) * (h / 2 - 8));
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = '#93c5fd';
        for (let i = 0; i < series.length; i++) {
            const x = Math.floor((i / Math.max(1, series.length - 1)) * w);
            const y = mid - Math.floor((series[i] / span) * (h / 2 - 8));
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
        if (typeof pointer === 'number') {
            const px = Math.floor((Math.min(Math.max(pointer, 0), Math.max(0, series.length - 1)) / Math.max(1, series.length - 1)) * w);
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, h);
            ctx.stroke();
        }
    }

    let engineWorker = null;
    let engineReady = false;
    let engineBusy = false;
    let engineHandler = null;

    // Helper to wrap WebSocket as a Worker-like object
    function createSocketWorker(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const worker = {
                postMessage: (msg) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(msg);
                    } else {
                        console.warn('WS not open, cannot send:', msg);
                        // If we try to send to a closed socket, invalidate the worker
                        if (engineWorker === worker) {
                            engineWorker = null;
                            engineReady = false;
                        }
                    }
                },
                terminate: () => ws.close(),
                onmessage: null
            };
            ws.onopen = () => resolve(worker);
            ws.onerror = (err) => reject(err);
            ws.onclose = () => {
                console.log('WS closed');
                if (engineWorker === worker) {
                    engineWorker = null;
                    engineReady = false;
                }
            };
            ws.onmessage = (e) => {
                if (worker.onmessage) worker.onmessage({ data: e.data });
            };
        });
    }

    async function initStockfish() {
        try {
            if (engineWorker) return engineReady;

            // Try connecting to backend first
            try {
                const backendWorker = await createSocketWorker('ws://localhost:8080');
                engineWorker = backendWorker;
                console.log('Connected to Stockfish backend');
            } catch (e) {
                console.log('Backend connection failed, falling back to local worker', e);
                const dynamic = (typeof window !== 'undefined' && typeof window.STOCKFISH_WORKER_PATH === 'string') ? [window.STOCKFISH_WORKER_PATH] : [];
                const candidates = dynamic.concat(['stockfish.js', 'stockfish-lite.js', 'stockfish-asm.js', 'stockfish.wasm.js']);
                let worker = null;
                for (let i = 0; i < candidates.length; i++) {
                    try { worker = new Worker(candidates[i]); break; } catch (e) { worker = null; }
                }
                if (!worker && typeof window !== 'undefined') {
                    const factory = (typeof window.Stockfish === 'function') ? window.Stockfish :
                        ((typeof window.STOCKFISH === 'function') ? window.STOCKFISH : null);
                    if (factory) {
                        try { worker = factory(); } catch (_) { worker = null; }
                    }
                }
                if (!worker) { engineWorker = null; engineReady = false; return false; }
                engineWorker = worker;
            }

            engineWorker.onmessage = function (e) {
                const line = (typeof e === 'string') ? e : ((e && e.data) ? String(e.data) : '');
                if (engineHandler) engineHandler(line);
            };
            await new Promise((resolve, reject) => {
                engineHandler = function (line) {
                    if (/uciok/.test(line)) { resolve(true); engineHandler = null; }
                };
                engineWorker.postMessage('uci');
                setTimeout(function () {
                    if (engineHandler) { engineHandler = null; reject(new Error('uci timeout')); }
                }, 4000);
            });
            await new Promise((resolve, reject) => {
                engineHandler = function (line) {
                    if (/readyok/.test(line)) { resolve(true); engineHandler = null; }
                };
                engineWorker.postMessage('isready');
                setTimeout(function () {
                    if (engineHandler) { engineHandler = null; reject(new Error('isready timeout')); }
                }, 4000);
            });
            engineWorker.postMessage('ucinewgame');
            engineReady = true;
            return true;
        } catch (err) {
            console.error('Stockfish init error:', err);
            engineWorker = null;
            engineReady = false;
            return false;
        }
    }

    function boardToFEN(b, side) {
        const rows = [];
        for (let r = 0; r < 8; r++) {
            let row = '';
            let empty = 0;
            for (let c = 0; c < 8; c++) {
                const p = b[r][c];
                if (!p) { empty++; continue; }
                if (empty > 0) { row += String(empty); empty = 0; }
                const isWhite = p[0] === 'w';
                const letter = p[1];
                row += isWhite ? letter : letter.toLowerCase();
            }
            if (empty > 0) row += String(empty);
            rows.push(row);
        }
        const placement = rows.join('/');
        const turn = side === 'w' ? 'w' : 'b';
        const castling = '-';
        const ep = '-';
        const halfmove = '0';
        const fullmove = '1';
        return placement + ' ' + turn + ' ' + castling + ' ' + ep + ' ' + halfmove + ' ' + fullmove;
    }

    function getEvalSettings() {
        return { mode: 'depth', value: 13 };
    }

    function parseScoreLine(line) {
        const mMate = line.match(/score\s+mate\s+(-?\d+)/);
        if (mMate) {
            const sign = parseInt(mMate[1], 10) >= 0 ? 1 : -1;
            return 99 * sign;
        }
        const mCp = line.match(/score\s+cp\s+(-?\d+)/);
        if (mCp) {
            return parseInt(mCp[1], 10) / 100;
        }
        return null;
    }

    function parsePvMoves(line) {
        if (typeof line !== 'string') return [];
        const idx = line.indexOf(' pv ');
        if (idx === -1) return [];
        const pvStr = line.slice(idx + 4).trim();
        const tokens = pvStr.split(/\s+/);
        const moves = [];
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t)) {
                moves.push(t);
            } else {
                break;
            }
        }
        return moves;
    }

    let currentAnalysisId = 0;

    async function evalFenDetailed(fen, settings) {
        if (!engineWorker || !engineReady) {
            const ok = await initStockfish();
            if (!ok) return { score: null, best: null };
        }
        if (engineBusy) return { score: null, best: null };
        engineBusy = true;
        let lastScore = null;
        let best = null;
        let lastPv = [];
        try {
            const timeoutMs = (settings && settings.mode === 'movetime') ? (settings.value + 3000) : 15000;
            const res = await new Promise((resolve) => {
                let resolved = false;
                const safeResolve = (val) => {
                    if (!resolved) {
                        resolved = true;
                        resolve(val);
                        engineHandler = null;
                    }
                };

                engineHandler = function (line) {
                    const s = parseScoreLine(line);
                    if (s !== null) lastScore = s;
                    const pv = parsePvMoves(line);
                    if (pv.length) lastPv = pv;
                    const bm = line.match(/bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
                    if (bm) { best = bm[1]; safeResolve({ score: lastScore, best, pv: lastPv }); }
                };

                try {
                    engineWorker.postMessage('stop');
                    engineWorker.postMessage('position fen ' + fen);
                    if (settings && settings.mode === 'depth') {
                        engineWorker.postMessage('go depth ' + settings.value);
                    } else {
                        const mt = settings && settings.value ? settings.value : 750;
                        engineWorker.postMessage('go movetime ' + mt);
                    }
                } catch (e) {
                    console.error('Error posting to worker:', e);
                    safeResolve({ score: null, best: null });
                    return;
                }

                setTimeout(function () {
                    if (!resolved) {
                        console.warn('Stockfish timeout, resetting worker');
                        if (engineWorker) {
                            if (engineWorker.terminate) engineWorker.terminate();
                            engineWorker = null;
                            engineReady = false;
                        }
                        safeResolve({ score: lastScore, best, pv: lastPv });
                    }
                }, timeoutMs);
            });
            return res;
        } finally {
            engineBusy = false;
        }
    }

    function evalToPercent(s) {
        if (s === null) return 0.5;
        if (Math.abs(s) >= 98) return s > 0 ? 0.99 : 0.01;
        const t = Math.tanh(s / 2);
        return (t + 1) / 2;
    }

    async function updateEvalBarForBoard(b, side) {
        if (!evalBar || !evalFill || !evalLabel) return;
        const ok = await initStockfish();
        if (!ok) { evalLabel.textContent = '-'; return; }
        const fen = boardToFEN(b, side);
        const det = await evalFenDetailed(fen, getEvalSettings());
        const pct = evalToPercent(det.score);
        const h = Math.round(pct * 100);
        evalFill.style.height = h + '%';
        if (det.score === null) {
            evalLabel.textContent = '-';
        } else {
            const val = (det.score >= 0 ? '+' : '') + det.score.toFixed(1);
            evalLabel.textContent = val;
        }
    }

    function updateEvalBarFromSeries(series, idx) {
        if (!evalBar || !evalFill || !evalLabel) return;
        if (!series || !series.length) { evalLabel.textContent = '-'; return; }
        const i = Math.max(0, Math.min(series.length - 1, idx));
        const s = series[i];
        const pct = evalToPercent(typeof s === 'number' ? s : 0);
        const h = Math.round(pct * 100);
        evalFill.style.height = h + '%';
        if (typeof s !== 'number') {
            evalLabel.textContent = '-';
            return;
        }
        const val = (s >= 0 ? '+' : '') + s.toFixed(1);
        evalLabel.textContent = val;
    }

    async function evaluateWithStockfish(tokens) {
        currentAnalysisId++;
        const myId = currentAnalysisId;
        const ok = await initStockfish();
        if (!ok) return null;
        const series = [];
        let b = initialBoard();
        let side = 'w';
        for (let i = 0; i < tokens.length; i++) {
            if (myId !== currentAnalysisId) { console.log('Analysis cancelled'); return null; }

            // Wait for engine to be free
            while (engineBusy) {
                if (myId !== currentAnalysisId) return null;
                await new Promise(r => setTimeout(r, 100));
            }

            if (message) message.textContent = `Analyzing move ${i + 1} / ${tokens.length} with Stockfish...`;
            const san = tokens[i];
            if (!san) continue;
            if (/^(1-0|0-1|1\/2-1\/2)$/.test(san)) break;
            const applied = applySAN(b, san.replace(/[!?]+/g, ''), side);
            if (applied) {
                const fen = boardToFEN(b, side === 'w' ? 'b' : 'w');
                const det = await evalFenDetailed(fen, getEvalSettings());

                if (myId !== currentAnalysisId) return null;

                const score = det ? det.score : null;
                if (score === null) { series.push(0); } else { series.push(score); }
                side = side === 'w' ? 'b' : 'w';
            } else {
                console.warn('Failed to apply move:', san, 'at index', i);
                if (message) message.textContent = `Analysis stopped: Move ${i + 1} (${san}) is invalid or unsupported.`;
                break;
            }
        }
        return series;
    }

    // Piece-Square Tables for better positional evaluation
    const PST = {
        P: [
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0],
            [1.0, 1.0, 2.0, 3.0, 3.0, 2.0, 1.0, 1.0],
            [0.5, 0.5, 1.0, 2.5, 2.5, 1.0, 0.5, 0.5],
            [0.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 0.0],
            [0.5, -0.5, -1.0, 0.0, 0.0, -1.0, -0.5, 0.5],
            [0.5, 1.0, 1.0, -2.0, -2.0, 1.0, 1.0, 0.5],
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        ],
        N: [
            [-5.0, -4.0, -3.0, -3.0, -3.0, -3.0, -4.0, -5.0],
            [-4.0, -2.0, 0.0, 0.0, 0.0, 0.0, -2.0, -4.0],
            [-3.0, 0.0, 1.0, 1.5, 1.5, 1.0, 0.0, -3.0],
            [-3.0, 0.5, 1.5, 2.0, 2.0, 1.5, 0.5, -3.0],
            [-3.0, 0.0, 1.5, 2.0, 2.0, 1.5, 0.0, -3.0],
            [-3.0, 0.5, 1.0, 1.5, 1.5, 1.0, 0.5, -3.0],
            [-4.0, -2.0, 0.0, 0.5, 0.5, 0.0, -2.0, -4.0],
            [-5.0, -4.0, -3.0, -3.0, -3.0, -3.0, -4.0, -5.0]
        ],
        B: [
            [-2.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -2.0],
            [-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0],
            [-1.0, 0.0, 0.5, 1.0, 1.0, 0.5, 0.0, -1.0],
            [-1.0, 0.5, 0.5, 1.0, 1.0, 0.5, 0.5, -1.0],
            [-1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, -1.0],
            [-1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0],
            [-1.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.5, -1.0],
            [-2.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -2.0]
        ],
        R: [
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [0.5, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.5],
            [-0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.5],
            [-0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.5],
            [-0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.5],
            [-0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.5],
            [-0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -0.5],
            [0.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0]
        ],
        Q: [
            [-2.0, -1.0, -1.0, -0.5, -0.5, -1.0, -1.0, -2.0],
            [-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0],
            [-1.0, 0.0, 0.5, 0.5, 0.5, 0.5, 0.0, -1.0],
            [-0.5, 0.0, 0.5, 0.5, 0.5, 0.5, 0.0, -0.5],
            [0.0, 0.0, 0.5, 0.5, 0.5, 0.5, 0.0, -0.5],
            [-1.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.0, -1.0],
            [-1.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, -1.0],
            [-2.0, -1.0, -1.0, -0.5, -0.5, -1.0, -1.0, -2.0]
        ],
        K: [
            [-3.0, -4.0, -4.0, -5.0, -5.0, -4.0, -4.0, -3.0],
            [-3.0, -4.0, -4.0, -5.0, -5.0, -4.0, -4.0, -3.0],
            [-3.0, -4.0, -4.0, -5.0, -5.0, -4.0, -4.0, -3.0],
            [-3.0, -4.0, -4.0, -5.0, -5.0, -4.0, -4.0, -3.0],
            [-2.0, -3.0, -3.0, -4.0, -4.0, -3.0, -3.0, -2.0],
            [-1.0, -2.0, -2.0, -2.0, -2.0, -2.0, -2.0, -1.0],
            [2.0, 2.0, 0.0, 0.0, 0.0, 0.0, 2.0, 2.0],
            [2.0, 3.0, 1.0, 0.0, 0.0, 1.0, 3.0, 2.0]
        ]
    };

    function evalPosition(b) {
        const pieceValues = { P: 10, N: 32, B: 33, R: 50, Q: 90, K: 2000 };
        let score = 0;

        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const piece = b[r][c];
                if (!piece) continue;

                const color = piece[0];
                const type = piece[1];
                const isWhite = color === 'w';

                // Base material value
                const material = pieceValues[type] || 0;

                // Position value from PST
                // PST table is from White's perspective (row 0 is black side)
                // For white: row is 7-r (to flip coordinate system)
                // For black: row is r, we flip c to maintain symmetry if needed but usually c is symmetric
                let pRow = isWhite ? r : (7 - r);
                let pCol = c;
                const positional = (PST[type] ? PST[type][pRow][pCol] : 0);

                if (isWhite) {
                    score += material + positional;
                } else {
                    score -= (material + positional);
                }
            }
        }
        return score / 10; // Normalized to 1.0 = pawn
    }

    function deriveEvalFromMoves(tokens) {
        const res = [];
        let b = initialBoard();
        let side = 'w';
        for (let i = 0; i < tokens.length; i++) {
            const san = tokens[i];
            if (!san) continue;
            if (/^(1-0|0-1|1\/2-1\/2)$/.test(san)) break;
            const ok = applySAN(b, san.replace(/[!?]+/g, ''), side);
            if (ok) {
                res.push(evalPosition(b));
                side = side === 'w' ? 'b' : 'w';
            }
        }
        return res;
    }

    const PIECE_UNI = {
        wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
        bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟'
    };

    const USE_IMAGE_PIECES = true;
    const PIECE_SRC = {
        wK: 'chess_icons/wK.png', wQ: 'chess_icons/wQ.png', wR: 'chess_icons/wR.png', wB: 'chess_icons/wB.png', wN: 'chess_icons/wN.png', wP: 'chess_icons/wP.png',
        bK: 'chess_icons/bK.png', bQ: 'chess_icons/bQ.png', bR: 'chess_icons/bR.png', bB: 'chess_icons/bB.png', bN: 'chess_icons/bN.png', bP: 'chess_icons/bP.png'
    };

    function algebraicToRC(sq) {
        const file = sq.charCodeAt(0) - 97;
        const rank = parseInt(sq[1], 10);
        const r = 8 - rank;
        const c = file;
        return { r, c };
    }

    function emptyBoard() {
        return Array.from({ length: 8 }, () => Array(8).fill(null));
    }

    function initialBoard() {
        const b = emptyBoard();
        for (let c = 0; c < 8; c++) { b[6][c] = 'wP'; b[1][c] = 'bP'; }
        b[7][0] = 'wR'; b[7][7] = 'wR'; b[0][0] = 'bR'; b[0][7] = 'bR';
        b[7][1] = 'wN'; b[7][6] = 'wN'; b[0][1] = 'bN'; b[0][6] = 'bN';
        b[7][2] = 'wB'; b[7][5] = 'wB'; b[0][2] = 'bB'; b[0][5] = 'bB';
        b[7][3] = 'wQ'; b[7][4] = 'wK'; b[0][3] = 'bQ'; b[0][4] = 'bK';
        return b;
    }

    function renderBoard(b) {
        if (!boardEl) return;
        boardEl.innerHTML = '';
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const sq = document.createElement('div');
                sq.className = 'square ' + (((r + c) % 2 === 0) ? 'light' : 'dark');
                const p = b[r][c];
                if (p) {
                    if (USE_IMAGE_PIECES && PIECE_SRC[p]) {
                        const img = document.createElement('img');
                        img.className = 'piece-img';
                        img.src = PIECE_SRC[p];
                        img.alt = p;
                        img.onerror = function () {
                            try { console.warn('Piece image failed to load:', p, 'src=', img.src); } catch (_) { }
                            if (img.parentNode === sq) sq.removeChild(img);
                            const span = document.createElement('span');
                            span.className = 'piece-symbol ' + (p[0] === 'w' ? 'piece-white' : 'piece-black');
                            span.textContent = PIECE_UNI[p] || '';
                            sq.appendChild(span);
                        };
                        sq.appendChild(img);
                    } else {
                        const span = document.createElement('span');
                        span.className = 'piece-symbol ' + (p[0] === 'w' ? 'piece-white' : 'piece-black');
                        span.textContent = PIECE_UNI[p] || '';
                        sq.appendChild(span);
                    }
                }
                boardEl.appendChild(sq);
            }
        }
        try {
            if (evalBar && boardEl && boardEl.offsetHeight) {
                evalBar.style.height = boardEl.offsetHeight + 'px';
            }
        } catch (_) { }
    }

    function pathClear(b, r, c, tr, tc) {
        const dr = Math.sign(tr - r);
        const dc = Math.sign(tc - c);
        let rr = r + dr, cc = c + dc;
        while (rr !== tr || cc !== tc) {
            if (b[rr][cc]) return false;
            rr += dr; cc += dc;
        }
        return true;
    }

    function candidatesFor(b, side, piece, target, hint) {
        const res = [];
        const { r: tr, c: tc } = algebraicToRC(target);
        const isWhite = side === 'w';
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const p = b[r][c];
                if (!p || p[0] !== side) continue;
                if (p[1] !== piece) continue;
                if (hint) {
                    if (/^[a-h]$/.test(hint) && (c !== hint.charCodeAt(0) - 97)) continue;
                    if (/^[1-8]$/.test(hint) && ((8 - r) !== parseInt(hint, 10))) continue;
                }
                if (piece === 'N') {
                    const d = Math.abs(r - tr) * 10 + Math.abs(c - tc);
                    if ((d === 12 || d === 21)) res.push({ r, c });
                } else if (piece === 'K') {
                    if (Math.max(Math.abs(r - tr), Math.abs(c - tc)) === 1) res.push({ r, c });
                } else if (piece === 'B') {
                    if (Math.abs(r - tr) === Math.abs(c - tc) && pathClear(b, r, c, tr, tc)) res.push({ r, c });
                } else if (piece === 'R') {
                    if ((r === tr || c === tc) && pathClear(b, r, c, tr, tc)) res.push({ r, c });
                } else if (piece === 'Q') {
                    if ((r === tr || c === tc || Math.abs(r - tr) === Math.abs(c - tc)) && pathClear(b, r, c, tr, tc)) res.push({ r, c });
                } else if (piece === 'P') {
                    const dir = isWhite ? -1 : 1;
                    const startRow = isWhite ? 6 : 1;

                    // In SAN, a pawn move is ONLY diagonal if it's a capture, 
                    // and captures for pawns ALWAYS include the starting file as a hint (e.g., "exf4" or "ef").
                    const isCaptureAttempt = !!(hint && /^[a-h]$/.test(hint));

                    if (isCaptureAttempt) {
                        // Diagonal capture (including potential en passant)
                        if (tr - r === dir && Math.abs(tc - c) === 1) res.push({ r, c });
                    } else {
                        // Regular move must be vertical
                        if (tc === c) {
                            if (tr - r === dir && !b[tr][tc]) res.push({ r, c });
                            // Double square move
                            if (tr - r === 2 * dir && r === startRow && !b[r + dir][c] && !b[tr][tc]) res.push({ r, c });
                        }
                    }
                }
            }
        }
        return res;
    }

    function applySAN(b, san, side) {
        san = san.replace(/[+#]+/g, '');
        if (/^O-O(-O)?$/.test(san)) {
            if (side === 'w') {
                if (san === 'O-O') { b[7][6] = 'wK'; b[7][5] = 'wR'; b[7][4] = null; b[7][7] = null; return true; }
                if (san === 'O-O-O') { b[7][2] = 'wK'; b[7][3] = 'wR'; b[7][4] = null; b[7][0] = null; return true; }
            } else {
                if (san === 'O-O') { b[0][6] = 'bK'; b[0][5] = 'bR'; b[0][4] = null; b[0][7] = null; return true; }
                if (san === 'O-O-O') { b[0][2] = 'bK'; b[0][3] = 'bR'; b[0][4] = null; b[0][0] = null; return true; }
            }
            return false;
        }
        const m = san.match(/^(?:([NBRQK])|)([a-h1-8]?)(x?)([a-h][1-8])(=?([QRNB]))?/);
        if (!m) return false;
        const piece = m[1] ? m[1] : 'P';
        const hint = m[2] || null;
        const target = m[4];
        const promo = m[6] || null;
        const { r: tr, c: tc } = algebraicToRC(target);
        const cands = candidatesFor(b, side, piece, target, hint);
        if (cands.length === 0) return false;
        const from = cands[0];
        const moving = piece === 'P' ? (side + 'P') : (side + piece);

        // En passant detection
        if (piece === 'P' && Math.abs(tc - from.c) === 1 && !b[tr][tc]) {
            const victimRow = side === 'w' ? tr + 1 : tr - 1;
            b[victimRow][tc] = null;
        }

        b[tr][tc] = promo ? (side + promo) : moving;
        b[from.r][from.c] = null;
        return true;
    }

    let currentIndex = 0;
    let currentMoves = [];
    function computeBoardToIndex(index) {
        let b = initialBoard();
        let side = 'w';
        let applied = 0;
        for (let i = 0; i < index; i++) {
            const san = currentMoves[i];
            if (!san) continue;
            if (/^(1-0|0-1|1\/2-1\/2)$/.test(san)) break;
            const ok = applySAN(b, san.replace(/[!?]+/g, ''), side);
            if (ok) { applied++; side = side === 'w' ? 'b' : 'w'; }
        }
        return { b, side };
    }

    function applyUci(b, uci, side) {
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promo = uci.length > 4 ? uci[4] : null;
        const f = algebraicToRC(from);
        const t = algebraicToRC(to);
        const moving = b[f.r][f.c];
        if (!moving) return false;
        const isK = moving[1] === 'K';
        const castleW = from === 'e1' && (to === 'g1' || to === 'c1');
        const castleB = from === 'e8' && (to === 'g8' || to === 'c8');
        b[t.r][t.c] = promo ? (side + promo.toUpperCase()) : moving;
        b[f.r][f.c] = null;
        if (isK && castleW) {
            if (to === 'g1') { b[7][5] = 'wR'; b[7][7] = null; }
            if (to === 'c1') { b[7][3] = 'wR'; b[7][0] = null; }
        }
        if (isK && castleB) {
            if (to === 'g8') { b[0][5] = 'bR'; b[0][7] = null; }
            if (to === 'c8') { b[0][3] = 'bR'; b[0][0] = null; }
        }
        return true;
    }

    let analysisPV = [];
    let analysisIndex = 0;
    let analysisBase = null;

    function renderPvList(pv) {
        if (!pvList) return;
        pvList.innerHTML = '';
        for (let i = 0; i < pv.length; i++) {
            const li = document.createElement('li');
            li.textContent = pv[i];
            if (i === analysisIndex) li.style.fontWeight = '700';
            pvList.appendChild(li);
        }
    }

    async function analyzeCurrentPosition() {
        const idx = Math.max(0, Math.min(currentMoves.length, currentIndex));
        const st = computeBoardToIndex(idx);
        analysisBase = { b: st.b, side: st.side };
        const det = await evalFenDetailed(boardToFEN(st.b, st.side), getEvalSettings());
        analysisPV = Array.isArray(det.pv) ? det.pv.slice(0, 16) : [];
        analysisIndex = 0;
        renderPvList(analysisPV);
        if (pvInfo) {
            if (det && typeof det.score === 'number') {
                const val = (det.score >= 0 ? '+' : '') + det.score.toFixed(2);
                pvInfo.textContent = 'Score: ' + val;
            } else {
                pvInfo.textContent = 'Score: -';
            }
        }
        renderBoard(st.b);
        updateEvalBarForBoard(st.b, st.side);
    }

    function stepPv(delta) {
        if (!analysisBase || !analysisPV || analysisPV.length === 0) return;
        analysisIndex = Math.max(0, Math.min(analysisPV.length, analysisIndex + delta));
        let b = JSON.parse(JSON.stringify(analysisBase.b));
        let side = analysisBase.side;
        for (let i = 0; i < analysisIndex; i++) {
            const uci = analysisPV[i];
            applyUci(b, uci, side);
            side = side === 'w' ? 'b' : 'w';
        }
        renderPvList(analysisPV);
        renderBoard(b);
        updateEvalBarForBoard(b, side);
    }
    function rebuildTo(index) {
        let b = initialBoard();
        let side = 'w';
        let applied = 0;
        for (let i = 0; i < index; i++) {
            const san = currentMoves[i];
            if (!san) continue;
            if (/^(1-0|0-1|1\/2-1\/2)$/.test(san)) break;
            const ok = applySAN(b, san.replace(/[!?]+/g, ''), side);
            if (ok) { applied++; side = side === 'w' ? 'b' : 'w'; }
        }
        renderBoard(b);
        if (window.chessPGN && Array.isArray(window.chessPGN.evals)) {
            drawEval(window.chessPGN.evals, applied);
        }
        if (moveStatus) moveStatus.textContent = 'Move ' + applied + ' / ' + currentMoves.length;
        const toMove = applied % 2 === 0 ? 'w' : 'b';
        if (window.chessPGN && Array.isArray(window.chessPGN.evals) && window.chessPGN.evals.length) {
            updateEvalBarFromSeries(window.chessPGN.evals, Math.max(0, applied - 1));
        } else {
            updateEvalBarForBoard(b, toMove);
        }
        return b;
    }

    function initBoard() {
        if (boardSection) boardSection.hidden = false;
        rebuildTo(currentIndex);
        if (firstBtn) firstBtn.onclick = function () { currentIndex = 0; rebuildTo(currentIndex); };
        if (prevBtn) prevBtn.onclick = function () { currentIndex = Math.max(0, currentIndex - 1); rebuildTo(currentIndex); };
        if (nextBtn) nextBtn.onclick = function () { currentIndex = Math.min(currentMoves.length, currentIndex + 1); rebuildTo(currentIndex); };
        if (lastBtn) lastBtn.onclick = function () { currentIndex = currentMoves.length; rebuildTo(currentIndex); };
    }

    button.addEventListener('click', async function () {
        try {
            const raw = input.value || '';
            const headers = parseHeaders(raw);
            const moves = extractMoves(raw);
            let evals = extractEvalSeries(raw);
            if (moves.length === 0) {
                if (message) message.textContent = 'No moves found';
                return;
            }
            if (message) message.textContent = 'Loaded ' + moves.length + ' moves';
            window.chessPGN = { raw: raw, headers: headers, moves: moves, evals: evals };
            if (metaWhite) metaWhite.textContent = headers.White || '-';
            if (metaBlack) metaBlack.textContent = headers.Black || '-';
            if (metaResult) metaResult.textContent = headers.Result || '-';
            if (metaEvent) metaEvent.textContent = headers.Event || '-';
            if (metaDate) metaDate.textContent = headers.Date || headers.UTCDate || '-';
            if (metadataCard) metadataCard.hidden = false;
            if (!evals || evals.length === 0) {
                const msgEl = message;
                if (msgEl) msgEl.textContent = 'Analyzing with Stockfish...';
                try {
                    const sfSeries = await evaluateWithStockfish(moves);
                    if (sfSeries && sfSeries.length) {
                        evals = sfSeries;
                        if (msgEl) msgEl.textContent = 'Stockfish analysis complete';
                    } else {
                        evals = deriveEvalFromMoves(moves);
                        if (msgEl) msgEl.textContent = 'Using material-based eval';
                    }
                } catch (e) {
                    evals = deriveEvalFromMoves(moves);
                    if (msgEl) msgEl.textContent = 'Using material-based eval';
                }
            }
            window.chessPGN.evals = evals;
            drawEval(evals, 0);
            updateEvalBarFromSeries(evals, 0);
            currentMoves = moves;
            currentIndex = 0;
            initBoard();
        } catch (err) {
            if (message) message.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
        }
    });

    if (analyzeBtn) {
        analyzeBtn.addEventListener('click', function () {
            analyzeCurrentPosition();
        });
    }
    if (pvPrev) {
        pvPrev.addEventListener('click', function () { stepPv(-1); });
    }
    if (pvNext) {
        pvNext.addEventListener('click', function () { stepPv(1); });
    }
    if (pvReset) {
        pvReset.addEventListener('click', function () {
            analysisIndex = 0;
            if (!analysisBase) return;
            renderPvList(analysisPV);
            renderBoard(analysisBase.b);
            updateEvalBarForBoard(analysisBase.b, analysisBase.side);
        });
    }
});
