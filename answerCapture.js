// Capture and manage student answers to questions on the whiteboard.

class AnswerCapture {
    constructor(wb) {
        this.wb = wb;

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
    }

    // ---- Question / answer capture setup ----

    initQuestions() {
        this.questions = [
            {
                id: 'q1',
                equation: '2x – 5 = 11',
                textX: this.wb.BOARD_WIDTH / 2 - 500,
                textY: this.wb.BOARD_HEIGHT / 2 - 400,
                // Initial capture zone: generous rectangle under and to the right of the equation
                zone: {
                    x: this.wb.BOARD_WIDTH / 2 - 500 - 250,
                    y: this.wb.BOARD_HEIGHT / 2 - 400 + 30,
                    w: 800,
                    h: 600,
                },
                // Dynamic bounding box — expands to contain all captured strokes
                bbox: null, // { x1, y1, x2, y2 } or null
                // Strokes that fall within this question's zone
                strokes: [],
                frozen: false, // false = still capturing, true = bbox is fixed (solved)
                recognizedLatex: null, // filled in by CoMER recognition
            }
        ];
    }

    // Compute the bounding box of a stroke from its points
    _getStrokeBbox(stroke) {
        if (stroke.points.length === 0) return null;
        let x1 = stroke.points[0].x, y1 = stroke.points[0].y;
        let x2 = x1, y2 = y1;
        for (const p of stroke.points) {
            if (p.x < x1) x1 = p.x;
            if (p.y < y1) y1 = p.y;
            if (p.x > x2) x2 = p.x;
            if (p.y > y2) y2 = p.y;
        }
        return { x1, y1, x2, y2 };
    }

    // Detect distinct horizontal lines within a question's strokes.
    // Groups strokes by Y-coordinate clustering, splitting when the
    // Y-gap between consecutive strokes exceeds 1.5× median stroke height.
    detectLines(question) {
        const strokes = question.strokes;
        if (strokes.length === 0) {
            question.lines = [];
            return;
        }

        // Compute Y-centre and height for each stroke
        const strokeData = [];
        for (const s of strokes) {
            const bbox = this._getStrokeBbox(s);
            if (!bbox) continue;
            strokeData.push({
                stroke: s,
                yCenter: (bbox.y1 + bbox.y2) / 2,
                height: bbox.y2 - bbox.y1,
                bbox,
            });
        }
        if (strokeData.length === 0) {
            question.lines = [];
            return;
        }

        // Sort by Y-centre top-to-bottom
        strokeData.sort((a, b) => a.yCenter - b.yCenter);

        // Compute median stroke height
        const heights = strokeData.map(d => d.height).sort((a, b) => a - b);
        const medianHeight = heights[Math.floor(heights.length / 2)];
        const gapThreshold = medianHeight * 1.5;

        // Debug: log line detection parameters
        console.log(`[detectLines] Question: ${question.id}, strokes: ${strokeData.length}, medianHeight: ${medianHeight.toFixed(1)}, gapThreshold: ${gapThreshold.toFixed(1)}`);

        // Cluster strokes into lines
        const clusters = [];
        let currentCluster = [strokeData[0]];

        for (let i = 1; i < strokeData.length; i++) {
            const prev = currentCluster[currentCluster.length - 1];
            const curr = strokeData[i];
            const yGap = curr.yCenter - prev.yCenter;

            if (yGap > gapThreshold) {
                // New line
                clusters.push(currentCluster);
                currentCluster = [curr];
            } else {
                currentCluster.push(curr);
            }
        }
        clusters.push(currentCluster);

                // Build line objects with bboxes
        question.lines = clusters.map((cluster, idx) => {
            let bbox = null;
            const lineStrokes = [];
            for (const sd of cluster) {
                lineStrokes.push(sd.stroke);
                if (bbox === null) {
                    bbox = { ...sd.bbox };
                } else {
                    if (sd.bbox.x1 < bbox.x1) bbox.x1 = sd.bbox.x1;
                    if (sd.bbox.y1 < bbox.y1) bbox.y1 = sd.bbox.y1;
                    if (sd.bbox.x2 > bbox.x2) bbox.x2 = sd.bbox.x2;
                    if (sd.bbox.y2 > bbox.y2) bbox.y2 = sd.bbox.y2;
                }
            }
            // Debug: log each line's Y-range
            if (bbox) {
                console.log(`[detectLines]   Line ${idx + 1}: ${lineStrokes.length} strokes, Y-range [${bbox.y1.toFixed(1)}, ${bbox.y2.toFixed(1)}], height=${(bbox.y2 - bbox.y1).toFixed(1)}`);
            }
            return {
                id: question.id + '_line' + (idx + 1),
                bbox,
                strokes: lineStrokes,
                recognizedLatex: null,
                candidates: [],
            };
        });
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

        // Re-detect lines for any question that captured this stroke
        for (const qId of capturedBy) {
            const q = this.questions.find(qq => qq.id === qId);
            if (q) this.detectLines(q);
        }
    }

    // Iteratively scan uncaptured strokes — any that newly intersect an expanded
    // bbox get captured, and the process repeats until no more captures occur.
    recheckUncapturedStrokes() {
        let changed = true;
        while (changed) {
            changed = false;
            for (const stroke of this.wb.strokes) {
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
            // Re-detect lines after removal
            this.detectLines(q);
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
            recognizedLatex: null,
        };

        // The previous question is now solved — freeze its bbox and clear the zone
        lastQ.frozen = true;
        if (lastQ.bbox) {
            lastQ.zone = null;
        }

        this.questions.push(newQ);
        this.wb.renderAllStrokes();
        console.log(`Added question "${id}": ${newQ.equation} at y=${newY}`);
    }

    // ---- End question capture ----

    // Draw the question equations and capture zone overlays onto the given context
    render(ctx) {
        // Draw the question equations
        ctx.fillStyle = '#444';
        ctx.font = 'bold 56px "Segoe UI", "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const q of this.questions) {
            ctx.fillText(q.equation, q.textX, q.textY);
        }

        // Draw a visual marker for each recognized question; the actual typeset
        // LaTeX is rendered by KaTeX in an HTML overlay in whiteboard.js.
        for (const q of this.questions) {
            if (q.recognizedLatex) {
                let y;
                if (q.bbox) {
                    y = q.bbox.y2 + 40;
                } else if (q.zone) {
                    y = q.zone.y + q.zone.h + 40;
                } else {
                    y = q.textY + 40;
                }
                const x = q.textX - 250;
                ctx.fillStyle = '#1a73e8';
                ctx.font = 'bold 22px "Segoe UI", Arial, sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText('→ recognized:', x, y);
                // Store the screen position so the HTML overlay can be placed.
                // y+28: start position for the top-1 LaTeX, then additional rows below.
                q._latexOverlayPos = { x, y: y + 28 };
                // Store positions for the candidate list (top-3 with scores)
                q._candidateOverlayPos = { x, y: y + 28 };
            }
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

                // Draw line-level catchment boxes (blue, with proportional padding)
                if (q.lines && q.lines.length > 0) {
                    for (const line of q.lines) {
                        if (!line.bbox) continue;

                        const lineW = line.bbox.x2 - line.bbox.x1;
                        const lineH = line.bbox.y2 - line.bbox.y1;
                        const vPad = lineH * 0.20;    // 20% vertical padding
                        const hPad = lineW * 1.0;      // 100% horizontal padding
                        const bx = line.bbox.x1 - hPad;
                        const by = line.bbox.y1 - vPad;
                        const bw = lineW + hPad * 2;
                        const bh = lineH + vPad * 2;

                        // Solid tight content bbox — exact region sent to the model
                        ctx.save();
                        ctx.strokeStyle = 'rgba(255, 87, 34, 0.7)';
                        ctx.lineWidth = 2;
                        ctx.strokeRect(line.bbox.x1, line.bbox.y1, lineW, lineH);

                        // Dashed line style for catchment indication
                        ctx.setLineDash([8, 6]);
                        ctx.fillStyle = 'rgba(33, 150, 243, 0.06)';
                        ctx.strokeStyle = 'rgba(33, 150, 243, 0.45)';
                        ctx.lineWidth = 2;
                        ctx.fillRect(bx, by, bw, bh);
                        ctx.strokeRect(bx, by, bw, bh);
                        ctx.setLineDash([]);

                        // Line label
                        ctx.fillStyle = 'rgba(33, 150, 243, 0.85)';
                        ctx.font = 'bold 16px "Segoe UI", Arial, sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'bottom';
                        ctx.fillText(`[${line.id}] ${line.strokes.length} stroke(s)`, bx, by - 4);
                        ctx.restore();
                    }
                }
            }
        }
    }

    toggleCaptureBoxes() {
        this.showCaptureBoxes = !this.showCaptureBoxes;
        this.wb.renderAllStrokes();
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
                if (s.points.length > 0) {
                    const first = s.points[0];
                    const last = s.points[s.points.length - 1];
                    console.log(`      First: ({ x: ${first.x.toFixed(1)}, y: ${first.y.toFixed(1)} })`);
                    console.log(`      Last:  ({ x: ${last.x.toFixed(1)}, y: ${last.y.toFixed(1)} })`);
                }
            }
            // Line detection info
            if (q.lines) {
                console.log(`  Lines detected: ${q.lines.length}`);
                for (const line of q.lines) {
                    console.log(`    ${line.id}: bbox=${line.bbox ? JSON.stringify(line.bbox) : 'null'}, strokes=${line.strokes.length}, recognizedLatex=${line.recognizedLatex || 'null'}`);
                }
            }
        }
        console.log('====================');
    }
}