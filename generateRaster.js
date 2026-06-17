// Rasterize the bbox region of the current active question and save as a PNG.
// Press 'r' to trigger.
// The image is always saved as "raster.png", so successive calls overwrite the same file.

// Rasterize a single line's bbox to a Blob (for API consumption).
// Returns null if no bbox.
function rasterizeLineToBlob(wb, line) {
    if (!line || !line.bbox) return null;

    const canvas = rasterizeBboxToCanvas(wb, line.bbox);
    if (!canvas) return null;

    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob), 'image/png');
    });
}

// Rasterize the active question's full bbox and return a Blob (for API consumption).
// Returns null if no active question or no bbox.
function rasterizeToBlob(wb) {
    const targetQ = findActiveQuestion(wb.answerCapture.questions);
    if (!targetQ || !targetQ.bbox) return null;

    const canvas = rasterizeBboxToCanvas(wb, targetQ.bbox);
    if (!canvas) return null;

    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob), 'image/png');
    });
}

// Rasterize a specific bbox region to a canvas.
function rasterizeBboxToCanvas(wb, bbox) {
    if (!bbox) return null;

    const x1 = Math.floor(bbox.x1);
    const y1 = Math.floor(bbox.y1);
    const x2 = Math.ceil(bbox.x2);
    const y2 = Math.ceil(bbox.y2);
    const w = x2 - x1;
    const h = y2 - y1;

    if (w <= 0 || h <= 0) return null;

    // Extract pixel data from the offscreen canvas at the bbox region
    const offscreenCtx = wb.offscreenCtx;
    const imageData = offscreenCtx.getImageData(x1, y1, w, h);

    // Create a temporary canvas at the exact bbox size and draw the extracted data
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(imageData, 0, 0);

    return tempCanvas;
}

// Find the latest non-frozen question.
function findActiveQuestion(questions) {
    for (let i = questions.length - 1; i >= 0; i--) {
        if (!questions[i].frozen) {
            return questions[i];
        }
    }
    return null;
}

// Original generateRaster — detects lines and downloads each line as a separate PNG.
function generateRaster(wb) {
    const targetQ = findActiveQuestion(wb.answerCapture.questions);
    if (!targetQ || !targetQ.bbox) return null;

    // Detect lines so we raster per-line
    wb.answerCapture.detectLines(targetQ);
    const lines = targetQ.lines || [];
    if (lines.length === 0) return;

    for (const line of lines) {
        if (!line.bbox) continue;

        const canvas = rasterizeBboxToCanvas(wb, line.bbox);
        if (!canvas) continue;

        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `${line.id}.png`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        const bbox = line.bbox;
        console.log(`Rasterized "${line.id}" bbox [${Math.floor(bbox.x1)}, ${Math.floor(bbox.y1)}, ${Math.ceil(bbox.x2)}, ${Math.ceil(bbox.y2)}] → ${line.id}.png`);
    }
}
