// Main whiteboard application logic: drawing, panning, tools, and answer capture integration.

const TOOLS = { MOUSE: 'mouse', PEN: 'pen', ERASER: 'eraser' };
const MAX_STROKES = 500;
const INTERP_STEP = 4;             // pixel spacing between stored points during live drawing

// ---- Standalone utility functions ----

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function interpolatePoints(fromX, fromY, toX, toY, stepSize) {
    const distance = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2);
    const steps = Math.max(1, Math.ceil(distance / stepSize));
    const points = [];
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        points.push({
            x: fromX + (toX - fromX) * t,
            y: fromY + (toY - fromY) * t,
        });
    }
    return points;
}

// Draw a polyline through a list of points using straight line segments.
function drawCurvePath(ctx, points) {
    if (points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }

    ctx.stroke();
}

class Whiteboard {
    constructor() {
        this.canvas = document.getElementById('whiteboard');
        this.ctx = this.canvas.getContext('2d');

        // Board dimensions (virtual space)
        this.BOARD_WIDTH = 5000;
        this.BOARD_HEIGHT = 5000;
        this.BG_COLOR = '#fefff1';
        this.gridSize = 40;
        this.gridDotSize = 2;
        this.gridPattern = null;

        // Offscreen canvas for full board rendering
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = this.BOARD_WIDTH;
        this.offscreenCanvas.height = this.BOARD_HEIGHT;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d');

        // Viewport offset (top-left of viewport in virtual space)
        this.offsetX = 0;
        this.offsetY = 0;

        // State
        this.isDrawing = false;
        this.currentTool = TOOLS.PEN;
        this.currentColor = '#000000';
        this.currentSize = 5;
        this.lastVirtualX = 0;
        this.lastVirtualY = 0;
        this.currentStroke = null;

        // Stroke-based history (lightweight, stores path data not pixels)
        this.strokes = [];

        // Panning state
        this.isPanning = false;
        this.panStartX = 0;
        this.panStartY = 0;
        this.panStartOffsetX = 0;
        this.panStartOffsetY = 0;

        // UI elements
        this.mouseBtn = document.getElementById('mouse');
        this.penBtn = document.getElementById('pen');
        this.eraserBtn = document.getElementById('eraser');
        this.colorPickerWrap = document.querySelector('.color-picker-wrap');
        this.colorBtn = document.querySelector('.color-btn');
        this.colorDropdown = document.querySelector('.color-picker-dropdown');
        this.colorSwatches = document.querySelectorAll('.color-swatch');
        this.sizePicker = document.getElementById('sizePicker');
        this.sizeValue = document.getElementById('sizeValue');
        this.toolbarToggle = document.querySelector('.toolbar-toggle');
        this.setCanvasSize();
        window.addEventListener('resize', () => this.setCanvasSize());

        // Answer capture system (questions, zones, stroke capture)
        this.answerCapture = new AnswerCapture(this);

        // Center the viewport on the board
        this.centerViewport();

        // Initialize offscreen board with grid
        this.renderAllStrokes();

        // Event listeners
        this.setupEventListeners();
    }

    get dpr() {
        return window.devicePixelRatio || 1;
    }

    setCanvasSize() {
        const container = this.canvas.parentElement;
        const dpr = this.dpr;

        // Set visible canvas dimensions (physical pixels)
        this.canvas.width = container.clientWidth * dpr;
        this.canvas.height = container.clientHeight * dpr;
        this.canvas.style.width = container.clientWidth + 'px';
        this.canvas.style.height = container.clientHeight + 'px';

        // Clamp offset to valid range after resize
        this.clampOffset();

        // Update the viewport
        this.renderViewport();
    }

    clampOffset() {
        const viewW = this.getViewportWidth();
        const viewH = this.getViewportHeight();
        this.offsetX = clamp(this.offsetX, 0, this.BOARD_WIDTH - viewW);
        this.offsetY = clamp(this.offsetY, 0, this.BOARD_HEIGHT - viewH);
    }

    getViewportWidth() {
        return this.canvas.width / this.dpr;
    }

    getViewportHeight() {
        return this.canvas.height / this.dpr;
    }

    // Center the viewport on the board
    centerViewport() {
        const viewW = this.getViewportWidth();
        const viewH = this.getViewportHeight();
        this.offsetX = Math.max(0, (this.BOARD_WIDTH - viewW) / 2);
        this.offsetY = Math.max(0, (this.BOARD_HEIGHT - viewH) / 2);
    }

    // Draw the grid dots on the offscreen canvas using a cached pattern
    drawGrid(ctx) {
        if (!this.gridPattern) {
            const patternCanvas = document.createElement('canvas');
            patternCanvas.width = this.gridSize;
            patternCanvas.height = this.gridSize;
            const patternCtx = patternCanvas.getContext('2d');
            patternCtx.fillStyle = 'rgba(0, 0, 0, 0.10)';
            patternCtx.fillRect(0, 0, this.gridDotSize, this.gridDotSize);
            this.gridPattern = ctx.createPattern(patternCanvas, 'repeat');
        }
        ctx.fillStyle = this.gridPattern;
        ctx.fillRect(0, 0, this.BOARD_WIDTH, this.BOARD_HEIGHT);
    }

    // Replay all strokes onto the offscreen canvas
    renderAllStrokes() {
        const ctx = this.offscreenCtx;

        // Clear with background color
        ctx.fillStyle = this.BG_COLOR;
        ctx.fillRect(0, 0, this.BOARD_WIDTH, this.BOARD_HEIGHT);

        // Draw grid
        this.drawGrid(ctx);

        // Draw answer capture elements (equations, zone overlays)
        this.answerCapture.render(ctx);

        // Replay all strokes
        for (const stroke of this.strokes) {
            this.renderStroke(ctx, stroke);
        }

        // Update visible viewport
        this.renderViewport();

        // Update any typeset LaTeX overlays on top of the canvas
        this.updateLatexOverlays();
    }

    // Update HTML overlays that show typeset LaTeX candidates and unified layout.
    // Renders per-line candidate panel (top-right) + unified LaTeX panel (below it).
    updateLatexOverlays() {
        const container = this.canvas.parentElement;
        if (!container) return;

        // Remove stale overlays
        const existing = container.querySelectorAll('.latex-overlay, .unified-latex-overlay');
        for (const el of existing) {
            el.remove();
        }

        // Find the active question (the one most recently recognized)
        let activeQ = null;
        for (const q of this.answerCapture.questions) {
            if (q.lines && q.lines.length > 0 && q.lines.some(l => l.candidates && l.candidates.length > 0)) {
                activeQ = q;
            }
        }
        if (!activeQ || !activeQ.lines) return;

        // ── Per-line candidate panel (top-right) ──
        const panel = document.createElement('div');
        panel.className = 'latex-overlay';
        container.appendChild(panel);

        for (const line of activeQ.lines) {
            if (!line.candidates || line.candidates.length === 0) continue;

            // Line header
            const lineHeader = document.createElement('div');
            lineHeader.className = 'latex-overlay-line-header';
            lineHeader.style.cssText = 'font-weight:bold;font-size:12px;color:#1a73e8;margin-top:8px;margin-bottom:2px;';
            lineHeader.textContent = line.id;
            panel.appendChild(lineHeader);

            const candidates = line.candidates;

            // Render top-1 candidate with confidence score
            const topRow = document.createElement('div');
            topRow.className = 'latex-overlay-top';
            topRow.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:4px;';
            panel.appendChild(topRow);

            const topLatex = document.createElement('span');
            topLatex.className = 'latex-overlay-latex';
            topRow.appendChild(topLatex);
            if (typeof renderLatex === 'function') {
                renderLatex(topLatex, candidates[0].latex);
            } else if (typeof katex !== 'undefined') {
                try {
                    katex.render(candidates[0].latex, topLatex, { throwOnError: false, displayMode: false });
                } catch (err) {
                    topLatex.textContent = candidates[0].latex;
                }
            } else {
                topLatex.textContent = candidates[0].latex;
            }

            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'latex-overlay-score';
            scoreSpan.textContent = `(${candidates[0].score.toFixed(3)})`;
            topRow.appendChild(scoreSpan);

            // Render alternates (2nd through 10th) below the top choice
            if (candidates.length > 1) {
                for (let i = 1; i < candidates.length; i++) {
                    const cand = candidates[i];
                    if (!cand.latex) continue;

                    const altRow = document.createElement('div');
                    altRow.className = 'latex-overlay-alt';

                    const altLatex = document.createElement('span');
                    altRow.appendChild(altLatex);
                    if (typeof renderLatex === 'function') {
                        renderLatex(altLatex, cand.latex);
                    } else if (typeof katex !== 'undefined') {
                        try {
                            katex.render(cand.latex, altLatex, { throwOnError: false, displayMode: false });
                        } catch (err) {
                            altLatex.textContent = cand.latex;
                        }
                    } else {
                        altLatex.textContent = cand.latex;
                    }

                    const altScore = document.createElement('span');
                    altScore.className = 'latex-overlay-score-alt';
                    altScore.textContent = `(${cand.score.toFixed(3)})`;
                    altRow.appendChild(altScore);

                    panel.appendChild(altRow);
                }
            }
        }

        // ── Unified LaTeX panel (below the candidate panel) ──
        if (!activeQ.unifiedLatex) return;

        const unifiedPanel = document.createElement('div');
        unifiedPanel.className = 'unified-latex-overlay';
        container.appendChild(unifiedPanel);

        const unifiedHeader = document.createElement('div');
        unifiedHeader.className = 'unified-latex-header';
        unifiedHeader.textContent = '📐 Unified Layout';
        unifiedPanel.appendChild(unifiedHeader);

        const unifiedContent = document.createElement('div');
        unifiedContent.className = 'unified-latex-content';
        unifiedPanel.appendChild(unifiedContent);

        if (typeof renderLatex === 'function') {
            renderLatex(unifiedContent, activeQ.unifiedLatex);
        } else if (typeof katex !== 'undefined') {
            try {
                katex.render(activeQ.unifiedLatex, unifiedContent, { throwOnError: false, displayMode: false });
            } catch (err) {
                unifiedContent.textContent = activeQ.unifiedLatex;
            }
        } else {
            unifiedContent.textContent = activeQ.unifiedLatex;
        }
    }

    // Render a single stroke onto a given context
    renderStroke(ctx, stroke) {
        if (stroke.points.length === 0) return;

        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';

        drawCurvePath(ctx, stroke.points);
    }

    // Copy the visible portion of the offscreen canvas to the viewport
    renderViewport() {
        const dpr = this.dpr;
        const viewW = this.canvas.width / dpr;
        const viewH = this.canvas.height / dpr;

        // Reset transform for DPI scaling
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Clear visible area
        this.ctx.clearRect(0, 0, viewW, viewH);

        // Draw the visible portion of the offscreen board
        this.ctx.drawImage(
            this.offscreenCanvas,
            this.offsetX, this.offsetY,   // source top-left in offscreen coords
            viewW, viewH,                 // source dimensions
            0, 0,                         // dest top-left
            viewW, viewH                  // dest dimensions
        );
    }

    // ---- Pointer position helpers ----

    getPointerPos(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: clientX - rect.left,
            y: clientY - rect.top,
        };
    }

    // Get viewport-relative position from a DOM event (mouse or touch)
    getEventPos(e) {
        const src = e.touches ? e.touches[0] : e;
        return this.getPointerPos(src.clientX, src.clientY);
    }

    // Convert viewport coordinates to virtual board coordinates
    viewportToVirtual(vpX, vpY) {
        return {
            x: vpX + this.offsetX,
            y: vpY + this.offsetY,
        };
    }

    // Check whether any point of a pen stroke falls within the eraser's radius
    doesEraserHitStroke(eraserPoints, stroke, eraserSize) {
        const halfSize = eraserSize / 2;
        const halfSq = halfSize * halfSize;
        for (const ep of eraserPoints) {
            const epx = ep.x;
            const epy = ep.y;
            for (const sp of stroke.points) {
                const dx = epx - sp.x;
                const dy = epy - sp.y;
                if (dx * dx + dy * dy <= halfSq) {
                    return true;
                }
            }
        }
        return false;
    }

    // ---- Drawing / panning handlers ----

    handlePanMove(viewportPos) {
        const dx = viewportPos.x - this.panStartX;
        const dy = viewportPos.y - this.panStartY;
        this.offsetX = clamp(this.panStartOffsetX - dx, 0, this.BOARD_WIDTH - this.getViewportWidth());
        this.offsetY = clamp(this.panStartOffsetY - dy, 0, this.BOARD_HEIGHT - this.getViewportHeight());
        this.renderViewport();
    }

    drawPenStroke(fromX, fromY, toX, toY) {
        const ctx = this.offscreenCtx;

        ctx.strokeStyle = this.currentColor;
        ctx.lineWidth = this.currentSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();

        const interpPoints = interpolatePoints(fromX, fromY, toX, toY, INTERP_STEP);
        for (const p of interpPoints) {
            this.currentStroke.points.push(p);
        }
    }

    // ---- Event triggers ----

    startDrawing(virtualPos) {
        this.isDrawing = true;
        this.lastVirtualX = virtualPos.x;
        this.lastVirtualY = virtualPos.y;

        if (this.currentTool === TOOLS.ERASER) {
            this.currentStroke = {
                tool: TOOLS.ERASER,
                size: this.currentSize,
                points: [{ x: virtualPos.x, y: virtualPos.y }],
            };
            this.currentEraserHits = new Set();
        } else {
            this.currentStroke = {
                tool: this.currentTool,
                color: this.currentColor,
                size: this.currentSize,
                points: [{ x: virtualPos.x, y: virtualPos.y }],
            };
        }
    }

    continueDrawing(virtualPos) {
        if (!this.isDrawing || !this.currentStroke) return;

        if (this.currentTool === TOOLS.PEN) {
            this.drawPenStroke(this.lastVirtualX, this.lastVirtualY, virtualPos.x, virtualPos.y);
        } else if (this.currentTool === TOOLS.ERASER) {
            const eraserSize = this.currentSize;
            const interpPoints = interpolatePoints(
                this.lastVirtualX, this.lastVirtualY,
                virtualPos.x, virtualPos.y,
                eraserSize
            );

            for (const p of interpPoints) {
                this.currentStroke.points.push(p);
            }

            // Check each pen stroke for intersection with the new eraser segment
            let anyHit = false;
            for (let i = this.strokes.length - 1; i >= 0; i--) {
                if (this.currentEraserHits.has(i)) continue;
                const stroke = this.strokes[i];
                if (stroke.tool !== TOOLS.PEN) continue;
                if (this.doesEraserHitStroke(interpPoints, stroke, eraserSize)) {
                    this.currentEraserHits.add(i);
                    anyHit = true;
                }
            }

            if (anyHit) {
                // Remove hit strokes (in descending index order to avoid shifting)
                const toRemove = [...this.currentEraserHits].sort((a, b) => b - a);
                for (const idx of toRemove) {
                    const removed = this.strokes[idx];
                    // Clean up question associations
                    this.answerCapture.removeStrokeFromQuestions(removed);
                    this.strokes.splice(idx, 1);
                }
                this.currentEraserHits.clear();
                this.renderAllStrokes();
            }
        }

        this.lastVirtualX = virtualPos.x;
        this.lastVirtualY = virtualPos.y;

        this.renderViewport();
    }

    finishDrawing() {
        if (this.isDrawing && this.currentStroke) {
            this.isDrawing = false;
            if (this.currentStroke.tool === TOOLS.ERASER) {
                this.currentEraserHits.clear();
            } else {
                this.strokes.push(this.currentStroke);
                // Capture this stroke into any question it belongs to
                this.answerCapture.captureStroke(this.currentStroke);
                // Enforce stroke limit — drop oldest strokes
                while (this.strokes.length > MAX_STROKES) {
                    const oldest = this.strokes.shift();
                    // If the oldest stroke was captured, remove it from questions
                    this.answerCapture.removeStrokeFromQuestions(oldest);
                }

                // Replace the temporary live line-segment preview with the final
                // proper rendering so stray segments do not remain on the board.
                this.renderAllStrokes();
            }
            this.currentStroke = null;
        }
    }

    startPanning(viewportPos) {
        this.isPanning = true;
        this.panStartX = viewportPos.x;
        this.panStartY = viewportPos.y;
        this.panStartOffsetX = this.offsetX;
        this.panStartOffsetY = this.offsetY;
        this.canvas.classList.add('grabbing');
    }

    stopPanning() {
        if (this.isPanning) {
            this.isPanning = false;
            this.canvas.classList.remove('grabbing');
        }
    }

    // ---- Unified pointer handler ----

    onPointerDown(pos) {
        if (this.currentTool === TOOLS.MOUSE) {
            this.startPanning(pos);
            return;
        }
        const virtual = this.viewportToVirtual(pos.x, pos.y);
        this.startDrawing(virtual);
    }

    onPointerMove(pos) {
        if (this.currentTool === TOOLS.MOUSE && this.isPanning) {
            this.handlePanMove(pos);
            return;
        }
        const virtual = this.viewportToVirtual(pos.x, pos.y);
        this.continueDrawing(virtual);
    }

    onPointerUp() {
        if (this.isPanning) this.stopPanning();
        if (this.isDrawing) this.finishDrawing();
    }

    // ---- Pointer event adapters (mouse and touch) ----

    onMouseDown(e)     { this.onPointerDown(this.getEventPos(e)); }
    onMouseMove(e)     { this.onPointerMove(this.getEventPos(e)); }
    onMouseUp()        { this.onPointerUp(); }

    onTouchStart(e)    { e.preventDefault(); this.onPointerDown(this.getEventPos(e)); }
    onTouchMove(e)     { e.preventDefault(); this.onPointerMove(this.getEventPos(e)); }
    onTouchEnd(e)      { e.preventDefault(); this.onPointerUp(); }

    // ---- Event setup ----

    setupEventListeners() {
        // Tool buttons
        this.mouseBtn.addEventListener('click', () => this.selectTool(TOOLS.MOUSE));
        this.penBtn.addEventListener('click', () => this.selectTool(TOOLS.PEN));
        this.eraserBtn.addEventListener('click', () => this.selectTool(TOOLS.ERASER));

        // Mouse events on canvas
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.onMouseUp());
        this.canvas.addEventListener('mouseleave', () => this.onMouseUp());

        // Touch events on canvas
        this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        this.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e));
        this.canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e));

        // Controls
        this.colorBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.colorDropdown.classList.toggle('open');
        });
        this.colorSwatches.forEach(swatch => {
            swatch.addEventListener('click', () => this.selectColor(swatch));
        });
        this.sizePicker.addEventListener('input', (e) => this.setSize(e.target.value));

        // Close color dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.colorPickerWrap.contains(e.target)) {
                this.colorDropdown.classList.remove('open');
            }
        });

        // Keyboard shortcuts
        const KEY_ACTIONS = {
            m: () => this.selectTool(TOOLS.MOUSE),
            p: () => this.selectTool(TOOLS.PEN),
            e: () => this.selectTool(TOOLS.ERASER),
            v: () => {
                this.answerCapture.toggleCaptureBoxes();
            },
            d: () => this.answerCapture.dumpCaptureData(),
            b: () => this.answerCapture.addNextQuestion(),
            r: () => generateRaster(this),
            t: () => {
                if (typeof recognizeActiveQuestion === 'function') {
                    recognizeActiveQuestion(this);
                }
            },
        };
        document.addEventListener('keydown', (e) => {
            const action = KEY_ACTIONS[e.key.toLowerCase()];
            if (action) action();
        });
    }

    selectTool(tool) {
        this.currentTool = tool;
        this.mouseBtn.classList.toggle('active', tool === TOOLS.MOUSE);
        this.penBtn.classList.toggle('active', tool === TOOLS.PEN);
        this.eraserBtn.classList.toggle('active', tool === TOOLS.ERASER);

        // Update collapsed toolbar icon to match current tool
        const iconPaths = { [TOOLS.MOUSE]: 'icons/cursor.png', [TOOLS.PEN]: 'icons/pencil.png', [TOOLS.ERASER]: 'icons/eraser.png' };
        const img = this.toolbarToggle.querySelector('img');
        if (img) img.src = iconPaths[tool];

        // Update cursor
        this.canvas.classList.toggle('mouse-mode', tool === TOOLS.MOUSE);
    }

    selectColor(swatch) {
        const color = swatch.dataset.color;
        this.currentColor = color;
        this.colorSwatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        this.colorBtn.style.background = color;
        this.colorDropdown.classList.remove('open');
    }

    setColor(color) {
        this.currentColor = color;
    }

    setSize(size) {
        this.currentSize = size;
        this.sizeValue.textContent = size;
    }

}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.whiteboard = new Whiteboard();
});