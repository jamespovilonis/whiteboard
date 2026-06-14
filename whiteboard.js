const TOOLS = { MOUSE: 'mouse', PEN: 'pen', ERASER: 'eraser' };
const MAX_STROKES = 500;
const SMOOTHING_STEPS = 12;        // subdivisions per segment (lower now since INTERP_STEP is small; 10–15 is enough for smoothness)
const INTERP_STEP = 4;             // pixel spacing between stored points during live drawing (lower = more points, smoother curves)
const TENSION = 0.1;              // Catmull-Rom tension: 0 = loose/round, 1 = tight/angular
const VELOCITY_IMPACT = 0.40;     // ±20% width variation based on velocity (ink-like effect)
const REF_SPEED = 50;             // reference speed in px per event for normalizing velocity in live drawing

// ---- Standalone utility functions ----

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function interpolatePoints(fromX, fromY, toX, toY, stepSize, rawVelocity = 0) {
    const distance = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2);
    const steps = Math.max(1, Math.ceil(distance / stepSize));
    const points = [];
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        points.push({
            x: fromX + (toX - fromX) * t,
            y: fromY + (toY - fromY) * t,
            velocity: rawVelocity,
        });
    }
    return points;
}

// Evaluate a Catmull-Rom spline segment between p1 and p2 at parameter t in [0,1].
// Uses p0 and p3 as preceding/following control points for smooth tangent calculation.
// Tension controls how tightly the curve hugs the control polygon.
function catmullRomPoint(p0, p1, p2, p3, t, tension) {
    const t2 = t * t;
    const t3 = t2 * t;

    const s = (1 - tension) / 2;

    // Catmull-Rom basis matrix coefficients
    const h1 =  2 * t3 - 3 * t2 + 1;
    const h2 = -2 * t3 + 3 * t2;
    const h3 =      t3 - 2 * t2 + t;
    const h4 =      t3 -     t2;

    return {
        x: h1 * p1.x + h2 * p2.x + s * (h3 * (p2.x - p0.x) + h4 * (p3.x - p1.x)),
        y: h1 * p1.y + h2 * p2.y + s * (h3 * (p2.y - p0.y) + h4 * (p3.y - p1.y)),
    };
}

function getSplineControls(points, index) {
    return {
        p0: index === 0
            ? { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y, velocity: points[0].velocity }
            : points[index - 1],
        p1: points[index],
        p2: points[index + 1],
        p3: index >= points.length - 2
            ? {
                x: 2 * points[points.length - 1].x - points[points.length - 2].x,
                y: 2 * points[points.length - 1].y - points[points.length - 2].y,
                velocity: points[points.length - 1].velocity,
            }
            : points[index + 2],
    };
}

function sampleSplinePoints(points, steps = SMOOTHING_STEPS) {
    if (points.length < 2) return points.slice();

    const samples = [{ ...points[0] }];
    for (let i = 0; i < points.length - 1; i++) {
        const { p0, p1, p2, p3 } = getSplineControls(points, i);
        const v1 = p1.velocity !== undefined ? p1.velocity : 0;
        const v2 = p2.velocity !== undefined ? p2.velocity : v1;

        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            const pt = catmullRomPoint(p0, p1, p2, p3, t, TENSION);
            samples.push({
                x: pt.x,
                y: pt.y,
                velocity: v1 + (v2 - v1) * t,
            });
        }
    }

    return samples;
}

// Compute the velocity-normalized width multiplier for a given velocity.
function velocityWidthMultiplier(velocity, minVel, maxVel, baseSize) {
    const velRange = maxVel - minVel;
    // Normalize: 0 = slowest (thickest), 1 = fastest (thinnest)
    const normalized = velRange === 0 ? 0 : clamp((velocity - minVel) / velRange, 0, 1);
    // Slow → +20%, fast → -20%
    return baseSize * (1 + VELOCITY_IMPACT * (1 - normalized));
}

// Group consecutive spline-sample segments whose widths are within WIDTH_TOLERANCE
// into a single continuous sub-path, avoiding the overlapping-round-cap pixelation
// that occurs when every segment is stroked individually.
const WIDTH_TOLERANCE = 0.4;       // if widths differ by less than this, they are drawn as one smooth sub-path

// Render a Catmull-Rom spline with per-segment variable width based on velocity.
// Each segment between adjacent points gets its own lineWidth computed from
// the average velocity of its endpoints.
function drawVariableWidthPath(ctx, points, baseSize) {
    if (points.length < 2) return;

    const smoothPoints = sampleSplinePoints(points);

    // Find velocity range across the entire stroke
    let minVel = Infinity, maxVel = -Infinity;
    for (const p of smoothPoints) {
        const v = p.velocity !== undefined ? p.velocity : 0;
        if (v < minVel) minVel = v;
        if (v > maxVel) maxVel = v;
    }
    // If no velocity data, fall back to uniform width
    if (minVel === Infinity) {
        ctx.lineWidth = baseSize;
        ctx.beginPath();
        ctx.moveTo(smoothPoints[0].x, smoothPoints[0].y);
        for (let i = 1; i < smoothPoints.length; i++) {
            ctx.lineTo(smoothPoints[i].x, smoothPoints[i].y);
        }
        ctx.stroke();
        return;
    }

    // Precompute widths for every segment
    const widths = [];
    for (let i = 0; i < smoothPoints.length - 1; i++) {
        const p1 = smoothPoints[i];
        const p2 = smoothPoints[i + 1];
        const avgVel = ((p1.velocity !== undefined ? p1.velocity : 0) +
            (p2.velocity !== undefined ? p2.velocity : 0)) / 2;
        widths.push(velocityWidthMultiplier(avgVel, minVel, maxVel, baseSize));
    }

    // Walk the segments, grouping consecutive segments whose widths are within tolerance.
    // Each group becomes one `beginPath()` / `stroke()` call to avoid overlapping round caps.
    let i = 0;
    while (i < smoothPoints.length - 1) {
        let j = i + 1;
        // Extend the group while the width changes less than the tolerance
        while (j < smoothPoints.length - 1 && Math.abs(widths[j] - widths[j - 1]) <= WIDTH_TOLERANCE) {
            j++;
        }
        // Use the average width of the group
        let sum = 0;
        for (let k = i; k < j; k++) sum += widths[k];
        ctx.lineWidth = sum / (j - i);

        ctx.beginPath();
        ctx.moveTo(smoothPoints[i].x, smoothPoints[i].y);
        for (let k = i + 1; k <= j; k++) {
            ctx.lineTo(smoothPoints[k].x, smoothPoints[k].y);
        }
        ctx.stroke();

        i = j; // move to next group
    }
}

// Render Catmull-Rom splines through a list of points.
// Each adjacent pair of stored points becomes a cubic curve segment
// that smoothly blends into the next with shared tangents.
function drawCurvePath(ctx, points) {
    if (points.length < 2) return;
    if (points.length === 2) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 0; i < points.length - 1; i++) {
        const { p0, p1, p2, p3 } = getSplineControls(points, i);

        for (let step = 1; step <= SMOOTHING_STEPS; step++) {
            const t = step / SMOOTHING_STEPS;
            const pt = catmullRomPoint(p0, p1, p2, p3, t, TENSION);
            ctx.lineTo(pt.x, pt.y);
        }
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
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';

        // Use variable-width rendering for pen strokes that have velocity data
        if (stroke.tool === TOOLS.PEN && stroke.points[0].velocity !== undefined) {
            drawVariableWidthPath(ctx, stroke.points, stroke.size);
        } else {
            ctx.lineWidth = stroke.size;
            drawCurvePath(ctx, stroke.points);
        }
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

        // Compute velocity (distance) for this segment
        const distance = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2);

        // Live drawing: show velocity-based width immediately
        // Reference speed centers the effect; slow = thicker, fast = thinner
        const velFactor = clamp(1 - distance / REF_SPEED, 0, 1);
        const liveWidth = this.currentSize * (1 + VELOCITY_IMPACT * velFactor);

        ctx.strokeStyle = this.currentColor;
        ctx.lineWidth = liveWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();

        // Store interpolated points with velocity data for later bezier rendering
        const interpPoints = interpolatePoints(fromX, fromY, toX, toY, INTERP_STEP, distance);
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
                points: [{ x: virtualPos.x, y: virtualPos.y, velocity: 0 }],
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

                // Replace the temporary live line-segment preview with the final
                // spline-rendered stroke so jagged segments do not remain on the board.
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