const TOOLS = { MOUSE: 'mouse', PEN: 'pen', ERASER: 'eraser' };
const MAX_STROKES = 500;

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

// Shared quadratic-bezier path rendering (used by both live drawing and stroke replay)
function drawCurvePath(ctx, points) {
    if (points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
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
        this.colorPicker = document.getElementById('colorPicker');
        this.sizePicker = document.getElementById('sizePicker');
        this.sizeValue = document.getElementById('sizeValue');
        this.toolbarToggle = document.querySelector('.toolbar-toggle');
        this.setCanvasSize();
        window.addEventListener('resize', () => this.setCanvasSize());

        // ---- Questions / answer capture ----
        this.questions = [];
        this.nextQuestionId = 2; // q1 already exists, so next is q2
        this.showCaptureBoxes = false; // press 'v' to toggle visual feedback
        this.equationBank = [
          '4x + 2 = 10',
          '5x - 3 = 12',
          '2x + 7 = 15',
          '6x - 4 = 20',
        ];
        this.nextEquationIndex = 0;

        // Define the initial equations
        this.initQuestions();

        // Center the viewport on the board
        this.centerViewport();

        // Initialize offscreen board with grid
        this.renderAllStrokes();

        // Event listeners
        this.setupEventListeners();
    }

    // ---- Question / answer capture setup ----

    initQuestions() {
        this.questions = [
            {
                id: 'q1',
                equation: '2x – 5 = 11',
                textX: this.BOARD_WIDTH / 2 - 500,
                textY: this.BOARD_HEIGHT / 2 - 400,
                // Initial capture zone: generous rectangle under and to the right of the equation
                zone: {
                    x: this.BOARD_WIDTH / 2 - 500 - 250,
                    y: this.BOARD_HEIGHT / 2 - 400 + 30,
                    w: 800,
                    h: 600,
                },
                // Dynamic bounding box — expands to contain all captured strokes
                bbox: null, // { x1, y1, x2, y2 } or null
                // Strokes that fall within this question's zone
                strokes: [],
                frozen: false, // false = still capturing, true = bbox is fixed (solved)
            }
        ];
    }

    // Check if a point falls within any question's capture zone OR within
    // any question's dynamic bbox (with padding for chain growth).
    // Returns the question object if found, or null.
    findQuestionForPoint(vx, vy, padding = 200) {
        for (const q of this.questions) {
            // Check against the static zone first (if it still exists)
            const z = q.zone;
            if (z !== null && vx >= z.x && vx <= z.x + z.w && vy >= z.y && vy <= z.y + z.h) {
                return q;
            }
            // Then check against the dynamic bbox (with padding) for chain growth
            // Skip frozen bboxes — solved questions no longer expand
            if (q.bbox && !q.frozen) {
                const bx = q.bbox.x1 - padding;
                const by = q.bbox.y1 - padding;
                const bw = q.bbox.x2 - q.bbox.x1 + padding * 2;
                const bh = q.bbox.y2 - q.bbox.y1 + padding * 2;
                if (vx >= bx && vx <= bx + bw && vy >= by && vy <= by + bh) {
                    return q;
                }
            }
        }
        return null;
    }

    // Expand a question's dynamic bounding box to include a stroke's points
    expandBboxForStroke(q, stroke) {
        for (const p of stroke.points) {
            if (q.bbox === null) {
                q.bbox = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
            } else {
                if (p.x < q.bbox.x1) q.bbox.x1 = p.x;
                if (p.y < q.bbox.y1) q.bbox.y1 = p.y;
                if (p.x > q.bbox.x2) q.bbox.x2 = p.x;
                if (p.y > q.bbox.y2) q.bbox.y2 = p.y;
            }
        }
    }

    // Capture a finished stroke into any question whose zone or bbox it falls into
    captureStroke(stroke) {
        let capturedBy = new Set();
        for (const p of stroke.points) {
            const q = this.findQuestionForPoint(p.x, p.y);
            if (q && !capturedBy.has(q.id)) {
                capturedBy.add(q.id);
                q.strokes.push(stroke);
                stroke.questionId = q.id;
                this.expandBboxForStroke(q, stroke);
            }
        }

        // After capturing this stroke, the bbox may have grown.
        // Re-check any previously uncaptured strokes to see if they now
        // intersect the expanded bbox (chain growth / long solutions).
        if (capturedBy.size > 0) {
            this.recheckUncapturedStrokes();
        }
    }

    // Iteratively scan uncaptured strokes — any that newly intersect an expanded
    // bbox get captured, and the process repeats until no more captures occur.
    recheckUncapturedStrokes() {
        let changed = true;
        while (changed) {
            changed = false;
            for (const stroke of this.strokes) {
                if (stroke.questionId) continue;
                for (const p of stroke.points) {
                    const q = this.findQuestionForPoint(p.x, p.y);
                    if (q) {
                        q.strokes.push(stroke);
                        stroke.questionId = q.id;
                        this.expandBboxForStroke(q, stroke);
                        changed = true;
                        break; // move to next stroke
                    }
                }
            }
        }
    }

    // Remove a stroke from the question that holds it (e.g., when erased)
    removeStrokeFromQuestions(stroke) {
        if (!stroke.questionId) return;
        const q = this.questions.find(q => q.id === stroke.questionId);
        if (!q) return;
        const idx = q.strokes.indexOf(stroke);
        if (idx !== -1) {
            q.strokes.splice(idx, 1);
            // Recompute bbox from remaining strokes
            q.bbox = null;
            for (const s of q.strokes) {
                this.expandBboxForStroke(q, s);
            }
        }
    }

    // Public method to retrieve captured strokes for a given question
    getCapturedStrokes(questionId) {
        const q = this.questions.find(q => q.id === questionId);
        return q ? q.strokes : [];
    }

    // Add a new question below the previous question's captured writing (or equation text)
    addNextQuestion() {
        const lastQ = this.questions[this.questions.length - 1];
        const id = 'q' + this.nextQuestionId;
        this.nextQuestionId++;

        // Determine vertical position:
        // If the last question has written content (bbox), place the new equation
        // below the bbox. Otherwise place it below the original equation text.
        let newY;
        if (lastQ.bbox) {
            newY = lastQ.bbox.y2 + 150;
        } else {
            newY = lastQ.textY + 600;
        }

        const equation = this.equationBank[this.nextEquationIndex % this.equationBank.length];
        this.nextEquationIndex++;

        const newQ = {
            id: id,
            equation: equation,
            textX: lastQ.textX,
            textY: newY,
            zone: {
                x: lastQ.textX - 250,
                y: newY + 30,
                w: 800,
                h: 600,
            },
            bbox: null,
            strokes: [],
            frozen: false,
        };

        // The previous question is now solved — freeze its bbox and clear the zone
        lastQ.frozen = true;
        if (lastQ.bbox) {
            lastQ.zone = null;
        }

        this.questions.push(newQ);
        this.renderAllStrokes();
        console.log(`Added question "${id}": ${newQ.equation} at y=${newY}`);
    }

    // ---- End question capture ----

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

        // Draw the question equations
        ctx.fillStyle = '#444';
        ctx.font = 'bold 56px "Segoe UI", "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const q of this.questions) {
            ctx.fillText(q.equation, q.textX, q.textY);
        }

        // Draw capture zone / bbox visual feedback (only when toggled on)
        if (this.showCaptureBoxes) {
            for (const q of this.questions) {
                // Draw the initial capture zone as a light blue, semi-transparent box (if it exists)
                if (q.zone !== null) {
                    ctx.fillStyle = 'rgba(100, 150, 255, 0.08)';
                    ctx.strokeStyle = 'rgba(100, 150, 255, 0.25)';
                    ctx.lineWidth = 2;
                    ctx.fillRect(q.zone.x, q.zone.y, q.zone.w, q.zone.h);
                    ctx.strokeRect(q.zone.x, q.zone.y, q.zone.w, q.zone.h);
                }

                // Draw the dynamic bounding box that fits the captured strokes
                if (q.bbox) {
                    const bx = q.bbox.x1 - 15;
                    const by = q.bbox.y1 - 15;
                    const bw = q.bbox.x2 - q.bbox.x1 + 30;
                    const bh = q.bbox.y2 - q.bbox.y1 + 30;
                    ctx.fillStyle = 'rgba(76, 175, 80, 0.10)';
                    ctx.strokeStyle = 'rgba(76, 175, 80, 0.6)';
                    ctx.lineWidth = 3;
                    ctx.fillRect(bx, by, bw, bh);
                    ctx.strokeRect(bx, by, bw, bh);

                    // Show stroke count
                    ctx.fillStyle = 'rgba(76, 175, 80, 0.9)';
                    ctx.font = 'bold 20px "Segoe UI", Arial, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(`[${q.id}] ${q.strokes.length} stroke(s)`, bx, by - 5);
                }

                // If there are captured strokes but no bbox yet (edge case), show a label
                if (!q.bbox && q.strokes.length > 0 && q.zone !== null) {
                    ctx.fillStyle = 'rgba(76, 175, 80, 0.9)';
                    ctx.font = 'bold 20px "Segoe UI", Arial, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(`[${q.id}] ${q.strokes.length} stroke(s)`, q.zone.x, q.zone.y - 5);
                }
            }
        }

        // Replay all strokes
        for (const stroke of this.strokes) {
            this.renderStroke(ctx, stroke);
        }

        // Update visible viewport
        this.renderViewport();
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

        const interpPoints = interpolatePoints(fromX, fromY, toX, toY, 2);

        drawCurvePath(ctx, interpPoints);

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
                    this.removeStrokeFromQuestions(removed);
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
                // Hit strokes were already removed during continueDrawing
            } else {
                this.strokes.push(this.currentStroke);
                // Capture this stroke into any question it belongs to
                this.captureStroke(this.currentStroke);
                // Enforce stroke limit — drop oldest strokes
                while (this.strokes.length > MAX_STROKES) {
                    const oldest = this.strokes.shift();
                    // If the oldest stroke was captured, remove it from questions too
                    this.removeStrokeFromQuestions(oldest);
                }
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
        this.colorPicker.addEventListener('change', (e) => this.setColor(e.target.value));
        this.sizePicker.addEventListener('input', (e) => this.setSize(e.target.value));

        // Keyboard shortcuts
        const KEY_ACTIONS = {
            m: () => this.selectTool(TOOLS.MOUSE),
            p: () => this.selectTool(TOOLS.PEN),
            e: () => this.selectTool(TOOLS.ERASER),
            v: () => { this.showCaptureBoxes = !this.showCaptureBoxes; this.renderAllStrokes(); },
            d: () => this.dumpCaptureData(),
            b: () => this.addNextQuestion(),
        };
        document.addEventListener('keydown', (e) => {
            const action = KEY_ACTIONS[e.key.toLowerCase()];
            if (action) action();
        });
    }

    // Dump capture data to console for verification
    dumpCaptureData() {
        console.log('=== CAPTURE DATA ===');
        for (const q of this.questions) {
            console.log(`Question "${q.id}": ${q.equation}`);
            console.log(`  Zone: ${q.zone ? `{ x: ${q.zone.x}, y: ${q.zone.y}, w: ${q.zone.w}, h: ${q.zone.h} }` : 'null (cleared)'}`);
            console.log(`  Dynamic bbox: ${q.bbox ? JSON.stringify(q.bbox) : 'null'}`);
            console.log(`  Captured strokes: ${q.strokes.length}`);
            for (let i = 0; i < q.strokes.length; i++) {
                const s = q.strokes[i];
                console.log(`    Stroke ${i + 1}: ${s.points.length} points, color=${s.color}, size=${s.size}`);
                // Log a few sample points to verify
                if (s.points.length > 0) {
                    const first = s.points[0];
                    const last = s.points[s.points.length - 1];
                    console.log(`      First: ({ x: ${first.x.toFixed(1)}, y: ${first.y.toFixed(1)} })`);
                    console.log(`      Last:  ({ x: ${last.x.toFixed(1)}, y: ${last.y.toFixed(1)} })`);
                }
            }
        }
        console.log('====================');
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
