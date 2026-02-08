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
    const firstBtn = document.getElementById('firstMove');
    const prevBtn = document.getElementById('prevMove');
    const nextBtn = document.getElementById('nextMove');
    const lastBtn = document.getElementById('lastMove');
    const moveStatus = document.getElementById('moveStatus');
    const analysisDepthSelect = document.getElementById('analysisDepth');
    const analysisThreadsSelect = document.getElementById('analysisThreads');
    const analysisMultiPVSelect = document.getElementById('analysisMultiPV');

    const analysisOverlay = document.getElementById('analysisOverlay');
    const analysisText = document.getElementById('analysisText');
    const analysisProgress = document.getElementById('analysisProgress');

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
        const w = evalCanvas.width;
        const h = evalCanvas.height;
        ctx.clearRect(0, 0, w, h);

        if (!series || series.length === 0) return;

        // Draw center line
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();

        for (let i = 0; i < series.length; i++) {
            const x = Math.floor((i / Math.max(1, series.length - 1)) * w);
            // Use evalToPercent to get 0..1 value (0=Black winning, 1=White winning)
            // Lichess style: 1.0 is top (White), 0.0 is bottom (Black).
            // Canvas Y: 0 is top, h is bottom.
            // So y = (1 - pct) * h
            const s = series[i];
            const pct = evalToPercent(s);
            const y = (1 - pct) * h;

            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Draw points? Maybe too cluttered. Let's skip points for now, just the line.

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

    function createSocketWorker(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const worker = {
                postMessage: (msg) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(msg);
                    } else {
                        console.warn('WS not open, cannot send:', msg);
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
            if (engineWorker && engineReady) return true;
            console.log('Stockfish: Starting initialization...');
            try {
                console.log('Stockfish: Attempting to connect to backend at ws://localhost:8080...');
                const backendWorker = await createSocketWorker('ws://localhost:8080');
                engineWorker = backendWorker;
                console.log('Stockfish: Connected to backend successfully');
            } catch (e) {
                console.warn('Stockfish: Backend connection failed, falling back to local/CDN worker', e);
                const candidates = ['stockfish.js', '/stockfish.js', './stockfish.js'];
                let worker = null;
                for (let i = 0; i < candidates.length; i++) {
                    try {
                        const src = candidates[i];
                        console.log(`Stockfish: Trying candidate: ${src}`);
                        worker = new Worker(src);
                        break;
                    } catch (e) {
                        console.warn(`Stockfish: Candidate ${candidates[i]} failed:`, e);
                        worker = null;
                    }
                }
                if (!worker && typeof window !== 'undefined') {
                    const factory = (typeof window.Stockfish === 'function') ? window.Stockfish :
                        ((typeof window.STOCKFISH === 'function') ? window.STOCKFISH : null);
                    if (factory) {
                        try {
                            console.log('Stockfish: Trying factory initialization');
                            worker = factory();
                        } catch (_) { worker = null; }
                    }
                }
                if (!worker) {
                    console.error('Stockfish: Failed to initialize any worker (local or CDN)');
                    engineWorker = null;
                    engineReady = false;
                    return false;
                }
                engineWorker = worker;
                console.log('Stockfish: Local/CDN worker initialized');
            }

            engineWorker.onmessage = function (e) {
                const line = (typeof e === 'string') ? e : ((e && e.data) ? String(e.data) : '');
                if (engineHandler) engineHandler(line);
            };

            await new Promise((resolve, reject) => {
                const handler = function (line) {
                    if (/uciok/.test(line)) { resolve(true); }
                };
                engineHandler = handler;
                engineWorker.postMessage('uci');
                setTimeout(() => reject(new Error('uci timeout')), 5000);
            });
            console.log('Stockfish: UCI initialized');

            await new Promise((resolve, reject) => {
                const handler = function (line) {
                    if (/readyok/.test(line)) { resolve(true); }
                };
                engineHandler = handler;
                engineWorker.postMessage('isready');
                setTimeout(() => reject(new Error('isready timeout')), 5000);
            });
            console.log('Stockfish: Engine ready');

            engineWorker.postMessage('ucinewgame');

            // Performance/Accuracy Settings (Defaults, will be refined in getEvalSettings)
            engineWorker.postMessage('setoption name Hash value 512');

            engineReady = true;
            return true;
        } catch (err) {
            console.error('Stockfish init error:', err);
            engineWorker = null;
            engineReady = false;
            return false;
        } finally {
            engineHandler = null;
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
        let depth = 18;
        let threads = 2;
        let multipv = 1;

        if (analysisDepthSelect) {
            const v = parseInt(analysisDepthSelect.value, 10);
            if (!isNaN(v)) depth = v;
        }
        if (analysisThreadsSelect) {
            const v = parseInt(analysisThreadsSelect.value, 10);
            if (!isNaN(v)) threads = v;
        }
        if (analysisMultiPVSelect) {
            const v = parseInt(analysisMultiPVSelect.value, 10);
            if (!isNaN(v)) multipv = parseInt(v, 10);
        }

        return { mode: 'depth', value: depth, threads, multipv };
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
        const pvMatch = line.match(/\spv\s+(.*)$/);
        if (!pvMatch) return [];
        const pvStr = pvMatch[1].trim();
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
        if (engineBusy) {
            if (engineWorker) engineWorker.postMessage('stop');
            await new Promise(r => setTimeout(r, 50));
        }
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

                    // Apply dynamic settings before analysis
                    if (settings.threads) engineWorker.postMessage(`setoption name Threads value ${settings.threads}`);
                    if (settings.multipv) engineWorker.postMessage(`setoption name MultiPV value ${settings.multipv}`);

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
                        console.warn('Stockfish analysis timed out, resolving with current results');
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
        // Mate handling: 
        // If s is > 90 (mate for white), return 0.99
        // If s is < -90 (mate for black), return 0.01
        if (s > 90) return 0.99;
        if (s < -90) return 0.01;

        // Lichess formula: 2 / (1 + exp(-0.004 * centipawns)) - 1
        // My 's' is pawns, so centipawns = s * 100
        // formula = 2 / (1 + exp(-0.4 * s)) - 1
        // But that formula returns -1 to 1.
        // We want 0 to 1.
        // So: 1 / (1 + exp(-0.4 * s))

        return 1 / (1 + Math.exp(-0.4 * s));
    }

    async function updateEvalBarForBoard(b, side) {
        if (!evalBar || !evalFill || !evalLabel) return;
        const ok = await initStockfish();
        if (!ok) { evalLabel.textContent = '-'; return; }
        const fen = boardToFEN(b, side);
        const det = await evalFenDetailed(fen, getEvalSettings());
        let score = det ? det.score : null;

        // Invert if side to move is Black
        if (score !== null && side === 'b') {
            score = -score;
        }

        const pct = evalToPercent(score);
        const h = Math.round(pct * 100);
        evalFill.style.height = h + '%';
        if (score === null) {
            evalLabel.textContent = '-';
        } else {
            const val = (score >= 0 ? '+' : '') + score.toFixed(1);
            evalLabel.textContent = val;
        }
    }

    async function evaluateWithStockfish(tokens) {
        currentAnalysisId++;
        const myId = currentAnalysisId;

        // Show overlay
        if (analysisOverlay) analysisOverlay.hidden = false;

        const ok = await initStockfish();
        if (!ok) {
            if (message) message.textContent = 'Stockfish failed to initialize.';
            if (analysisOverlay) analysisOverlay.hidden = true;
            return null;
        }

        const series = [];
        let b = initialBoard();
        let side = 'w';

        // Settings for "Fast but decent" analysis
        const settings = { mode: 'depth', value: 18, threads: 2, multipv: 1 };

        for (let i = 0; i < tokens.length; i++) {
            if (myId !== currentAnalysisId) { console.log('Analysis cancelled'); break; }

            // Update overlay
            if (analysisText) analysisText.textContent = `Analyzing move ${i + 1} / ${tokens.length}`;
            if (analysisProgress) {
                const pct = ((i + 1) / tokens.length) * 100;
                analysisProgress.style.width = `${pct}%`;
            }

            const san = tokens[i];
            if (!san) continue;
            if (/^(1-0|0-1|1\/2-1\/2)$/.test(san)) break;

            const applied = applySAN(b, san.replace(/[!?]+/g, ''), side);
            if (applied) {
                const fen = boardToFEN(b, side === 'w' ? 'b' : 'w');
                // Use the requested depth: 18
                const det = await evalFenDetailed(fen, settings);

                if (myId !== currentAnalysisId) break;

                let score = det ? det.score : null;

                // Stockfish returns score from the perspective of the side to move.
                // We want the score from White's perspective.
                // The FEN we just analyzed has side-to-move as (side === 'w' ? 'b' : 'w').
                // If side-to-move is Black, we must invert the score.
                const sideToMove = side === 'w' ? 'b' : 'w';
                if (score !== null && sideToMove === 'b') {
                    score = -score;
                }

                if (score === null) {
                    series.push(series.length > 0 ? series[series.length - 1] : 0);
                } else {
                    series.push(score);
                }

                side = side === 'w' ? 'b' : 'w';
            } else {
                console.warn('Failed to apply move:', san);
                break;
            }
        }

        // Hide overlay when done
        if (analysisOverlay) analysisOverlay.hidden = true;
        return series;
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
                    const isCaptureAttempt = !!(hint && /^[a-h]$/.test(hint));
                    if (isCaptureAttempt) {
                        if (tr - r === dir && Math.abs(tc - c) === 1) res.push({ r, c });
                    } else {
                        if (tc === c) {
                            if (tr - r === dir && !b[tr][tc]) res.push({ r, c });
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
        const cands = candidatesFor(b, side, piece, target, hint);
        if (cands.length === 0) return false;
        const from = cands[0];
        const moving = piece === 'P' ? (side + 'P') : (side + piece);
        const { r: tr, c: tc } = algebraicToRC(target);
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
        // updateClassification(applied); // Removed
        if (moveStatus) moveStatus.textContent = 'Move ' + applied + ' / ' + currentMoves.length;
        const toMove = applied % 2 === 0 ? 'w' : 'b';

        // SYNC FIX: If we have a pre-computed eval, use it!
        let hasPrecomputed = false;
        if (window.chessPGN && Array.isArray(window.chessPGN.evals) && window.chessPGN.evals.length > applied) {
            // The evals array maps 1:1 to moves? 
            // Usually evals[0] is state after move 1? Or state after move 0 (start)?
            // Let's check evaluateWithStockfish push logic.
            // It pushes after every move. evals[0] is after move 1.
            // But index 0 in rebuildTo means "start position".
            // If applied === 0 (start), we have no eval usually (or maybe 0.5/0.2 from start).
            // evaluateWithStockfish starts loop at i=0 (move 1).
            // So evals[i] corresponds to state after move i+1.
            // applied is the number of moves applied.
            // If applied == 0, we can default to 0.2 (start).
            // If applied > 0, we want evals[applied - 1].

            if (applied > 0) {
                const score = window.chessPGN.evals[applied - 1];
                if (typeof score === 'number' || typeof score === 'string') {
                    // We have a value! Update bar directly.
                    // We need to construct a mini-series or just reuse updateEvalBarFromSeries logic?
                    // updateEvalBarFromSeries takes (series, idx).
                    updateEvalBarFromSeries(window.chessPGN.evals, applied - 1);
                    hasPrecomputed = true;
                }
            } else {
                // Start position
                updateEvalBarFromSeries([0.2], 0);
                hasPrecomputed = true;
            }
        }

        if (!hasPrecomputed) {
            // Only if we don't have it, ask Stockfish (async)
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

            // If pgn has no embedded evals, run our own analysis
            if (!evals || evals.length === 0) {
                if (message) message.textContent = 'Starting analysis (Depth 15)...';
                try {
                    // This will block interaction via the overlay
                    const sfSeries = await evaluateWithStockfish(moves);
                    if (sfSeries && sfSeries.length) {
                        evals = sfSeries;
                        if (message) message.textContent = 'Analysis complete.';
                    } else {
                        evals = [];
                        if (message) message.textContent = 'Analysis failed or cancelled.';
                    }
                } catch (e) {
                    evals = [];
                    if (message) message.textContent = 'Error: ' + e.message;
                    if (analysisOverlay) analysisOverlay.hidden = true;
                }
            } else {
                // If embedded evals exist, just show them
                if (message) message.textContent = 'Loaded embedded evaluations.';
            }

            window.chessPGN.evals = evals;

            // Draw result
            if (evals.length > 0) {
                drawEval(evals, 0);
                updateEvalBarFromSeries(evals, 0);
            }

            currentMoves = moves;
            currentIndex = 0;
            initBoard();
        } catch (err) {
            if (message) message.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
            console.error('Full error:', err);
        }
    });
});
