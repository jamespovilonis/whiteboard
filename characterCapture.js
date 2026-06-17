// Capture and group strokes into individual characters based on proximity/overlap.

class CharacterCapture {
    constructor(wb) {
        this.wb = wb;

        // Character groups — each is { id, bbox, strokes }
        this.characters = [];
        this.nextCharId = 1;
        this.showCaptureBoxes = false; // press 'v' to toggle visual feedback

    }

    // ---- Stroke capture ----

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

    // Compute the merge threshold as 2% of the character's max dimension (width or height)
    _getMergeThreshold(char) {
        if (!char.bbox) return 30; // fallback for first stroke
        const w = char.bbox.x2 - char.bbox.x1;
        const h = char.bbox.y2 - char.bbox.y1;
        return Math.max(w, h) * 0.02;
    }

    // Get a character's bounding box with padding applied for overlap checking
    _getPaddedBbox(char) {
        if (!char.bbox) return null;
        const padding = this._getMergeThreshold(char);
        return {
            x1: char.bbox.x1 - padding,
            y1: char.bbox.y1 - padding,
            x2: char.bbox.x2 + padding,
            y2: char.bbox.y2 + padding,
        };
    }

    // Check if two padded axis-aligned bounding boxes overlap
    _bboxesOverlap(a, b) {
        return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
    }

    // Check if any point of a stroke lies within a character's padded bbox
    _strokeHitsCharacter(stroke, char) {
        const pb = this._getPaddedBbox(char);
        if (!pb) return false;
        for (const p of stroke.points) {
            if (p.x >= pb.x1 && p.x <= pb.x2 && p.y >= pb.y1 && p.y <= pb.y2) {
                return true;
            }
        }
        return false;
    }

    // Check if any point of one stroke is within `threshold` of any point of another stroke
    _strokesNearby(a, b, threshold) {
        const threshSq = threshold * threshold;
        // Use bbox check as fast filter first
        const ba = this._getStrokeBbox(a);
        const bb = this._getStrokeBbox(b);
        if (!ba || !bb) return false;
        const paddedA = {
            x1: ba.x1 - threshold,
            y1: ba.y1 - threshold,
            x2: ba.x2 + threshold,
            y2: ba.y2 + threshold,
        };
        if (!this._bboxesOverlap(paddedA, bb)) return false;

        // Point-to-point distance check
        for (const pa of a.points) {
            for (const pb of b.points) {
                const dx = pa.x - pb.x;
                const dy = pa.y - pb.y;
                if (dx * dx + dy * dy <= threshSq) {
                    return true;
                }
            }
        }
        return false;
    }

    // Expand a character's bounding box to include a stroke
    _expandCharBbox(char, stroke) {
        for (const p of stroke.points) {
            if (char.bbox === null) {
                char.bbox = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
            } else {
                if (p.x < char.bbox.x1) char.bbox.x1 = p.x;
                if (p.y < char.bbox.y1) char.bbox.y1 = p.y;
                if (p.x > char.bbox.x2) char.bbox.x2 = p.x;
                if (p.y > char.bbox.y2) char.bbox.y2 = p.y;
            }
        }
    }

    // Capture a finished stroke — group it into an existing character or create a new one
    captureStroke(stroke) {
        // Find all characters this stroke overlaps/near-intersects
        const hitChars = [];
        for (const char of this.characters) {
            if (this._strokeHitsCharacter(stroke, char)) {
                hitChars.push(char);
            } else {
                // Fallback: check point-to-point proximity with any existing stroke in the character
                const threshold = this._getMergeThreshold(char);
                for (const existingStroke of char.strokes) {
                    if (this._strokesNearby(stroke, existingStroke, threshold)) {
                        hitChars.push(char);
                        break;
                    }
                }
            }
        }

        if (hitChars.length === 0) {
            // No overlap — create a new character group
            const newChar = {
                id: 'c' + this.nextCharId++,
                bbox: null,
                strokes: [],
            };
            newChar.strokes.push(stroke);
            stroke.charGroupId = newChar.id;
            this._expandCharBbox(newChar, stroke);
            this.characters.push(newChar);
        } else if (hitChars.length === 1) {
            // Belongs to exactly one character — add to it
            const char = hitChars[0];
            char.strokes.push(stroke);
            stroke.charGroupId = char.id;
            this._expandCharBbox(char, stroke);
        } else {
            // Overlaps multiple characters — merge them into one
            const primary = hitChars[0];
            const merged = new Set([primary]);
            for (let i = 1; i < hitChars.length; i++) {
                const other = hitChars[i];
                if (merged.has(other)) continue;
                merged.add(other);
                // Move strokes from other to primary
                for (const s of other.strokes) {
                    s.charGroupId = primary.id;
                    primary.strokes.push(s);
                }
                // Expand primary bbox to include other's bbox
                if (other.bbox) {
                    if (primary.bbox === null) {
                        primary.bbox = { ...other.bbox };
                    } else {
                        if (other.bbox.x1 < primary.bbox.x1) primary.bbox.x1 = other.bbox.x1;
                        if (other.bbox.y1 < primary.bbox.y1) primary.bbox.y1 = other.bbox.y1;
                        if (other.bbox.x2 > primary.bbox.x2) primary.bbox.x2 = other.bbox.x2;
                        if (other.bbox.y2 > primary.bbox.y2) primary.bbox.y2 = other.bbox.y2;
                    }
                }
                // Remove the merged character
                const idx = this.characters.indexOf(other);
                if (idx !== -1) this.characters.splice(idx, 1);
            }
            // Add the new stroke to the merged character
            primary.strokes.push(stroke);
            stroke.charGroupId = primary.id;
            this._expandCharBbox(primary, stroke);
        }
    }

    // Remove a stroke from its character group (e.g., when erased)
    removeStrokeFromCharacters(stroke) {
        if (!stroke.charGroupId) return;
        const char = this.characters.find(c => c.id === stroke.charGroupId);
        if (!char) return;
        const idx = char.strokes.indexOf(stroke);
        if (idx !== -1) {
            char.strokes.splice(idx, 1);
            // Recompute bbox from remaining strokes
            char.bbox = null;
            for (const s of char.strokes) {
                this._expandCharBbox(char, s);
            }
            // If no strokes remain, remove the character group
            if (char.strokes.length === 0) {
                const charIdx = this.characters.indexOf(char);
                if (charIdx !== -1) this.characters.splice(charIdx, 1);
            }
        }
        stroke.charGroupId = null;
    }

    // ---- Render ----

    // Draw character bounding box overlays onto the given context
    render(ctx) {
        if (!this.showCaptureBoxes) return;

        // Distinct color palette for character boxes (different from AnswerCapture's green)
        const colors = [
            { fill: 'rgba(255, 152, 0, 0.10)', stroke: 'rgba(255, 152, 0, 0.6)' },
            { fill: 'rgba(233, 30, 99, 0.10)', stroke: 'rgba(233, 30, 99, 0.6)' },
            { fill: 'rgba(0, 188, 212, 0.10)', stroke: 'rgba(0, 188, 212, 0.6)' },
            { fill: 'rgba(156, 39, 176, 0.10)', stroke: 'rgba(156, 39, 176, 0.6)' },
        ];

        for (let i = 0; i < this.characters.length; i++) {
            const char = this.characters[i];
            if (!char.bbox) continue;

            const c = colors[i % colors.length];
            const pad = 12;
            const bx = char.bbox.x1 - pad;
            const by = char.bbox.y1 - pad;
            const bw = char.bbox.x2 - char.bbox.x1 + pad * 2;
            const bh = char.bbox.y2 - char.bbox.y1 + pad * 2;

            // Fill and stroke the box
            ctx.fillStyle = c.fill;
            ctx.strokeStyle = c.stroke;
            ctx.lineWidth = 2;
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeRect(bx, by, bw, bh);

            // Show char label and stroke count
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.font = 'bold 16px "Segoe UI", Arial, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`[${char.id}] ${char.strokes.length} stroke(s)`, bx, by - 4);
        }
    }

    // ---- Toggle ----

    toggleCaptureBoxes() {
        this.showCaptureBoxes = !this.showCaptureBoxes;
        this.wb.renderAllStrokes();
    }

    // ---- Debug ----

    dumpCaptureData() {
        console.log('=== CHARACTER CAPTURE DATA ===');
        console.log(`Total character groups: ${this.characters.length}`);
        for (const char of this.characters) {
            console.log(`  Character "${char.id}":`);
            console.log(`    Bbox: ${char.bbox ? JSON.stringify(char.bbox) : 'null'}`);
            console.log(`    Strokes: ${char.strokes.length}`);
            for (let i = 0; i < char.strokes.length; i++) {
                const s = char.strokes[i];
                console.log(`      Stroke ${i + 1}: ${s.points.length} points, color=${s.color}, size=${s.size}`);
                if (s.points.length > 0) {
                    const first = s.points[0];
                    const last = s.points[s.points.length - 1];
                    console.log(`        First: ({ x: ${first.x.toFixed(1)}, y: ${first.y.toFixed(1)} })`);
                    console.log(`        Last:  ({ x: ${last.x.toFixed(1)}, y: ${last.y.toFixed(1)} })`);
                }
            }
        }
        console.log('===============================');
    }
}