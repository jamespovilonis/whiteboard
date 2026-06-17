// Rasterize the bbox region of the current active question and save as a PNG.
// Press 'r' to trigger.
// The image is always saved as "raster.png", so successive calls overwrite the same file.

// Rasterize the active question and return a Blob (for API consumption).
// Returns null if no active question or no bbox.
function rasterizeToBlob(wb) {
    const targetQ = findActiveQuestion(wb.answerCapture.questions);
    if (!targetQ || !targetQ.bbox) return null;

    const canvas = rasterizeToCanvas(wb, targetQ);
    if (!canvas) return null;

    // Convert canvas to Blob
    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob), 'image/png');
    });
}

// Rasterize a specific question's bbox region to a canvas.
function rasterizeToCanvas(wb, targetQ) {
    if (!targetQ || !targetQ.bbox) return null;

    const bbox = targetQ.bbox;
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

// Original generateRaster — downloads the raster as a PNG file.
function generateRaster(wb) {
    const targetQ = findActiveQuestion(wb.answerCapture.questions);
    const canvas = rasterizeToCanvas(wb, targetQ);
    if (!canvas) return;

    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = 'raster.png';
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    const bbox = targetQ.bbox;
    console.log(`Rasterized question "${targetQ.id}" bbox [${Math.floor(bbox.x1)}, ${Math.floor(bbox.y1)}, ${Math.ceil(bbox.x2)}, ${Math.ceil(bbox.y2)}] → raster.png`);
}