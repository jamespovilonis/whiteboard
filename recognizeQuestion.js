// Send a rasterized PNG of the current question to the CoMER API
// and display the recognized LaTeX on the whiteboard.

const COMER_API_URL = 'http://localhost:8000';
const SERVER_STATUS_INTERVAL_MS = 5000;

let isRecognizing = false;
let serverStatusEl = null;
let toastEl = null;
let recognizeBtn = null;

// Initialize UI helpers once the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
    serverStatusEl = document.getElementById('serverStatus');
    toastEl = document.getElementById('toast');
    recognizeBtn = document.getElementById('recognize');

    if (recognizeBtn) {
        recognizeBtn.addEventListener('click', () => {
            if (window.whiteboard) {
                recognizeActiveQuestion(window.whiteboard);
            }
        });
    }

    // Poll the server status so the indicator is accurate.
    checkComerServer().then(updateServerStatusIndicator);
    setInterval(() => {
        checkComerServer().then(updateServerStatusIndicator);
    }, SERVER_STATUS_INTERVAL_MS);
});

function updateServerStatusIndicator(isOnline) {
    if (!serverStatusEl) return;
    serverStatusEl.classList.toggle('online', isOnline);
    serverStatusEl.title = isOnline ? 'CoMER server online' : 'CoMER server offline (run models/start_server.sh)';
}

function showToast(message, type = 'info', durationMs = 4000) {
    if (!toastEl) {
        // Fallback if the toast element is missing
        if (type === 'error') {
            console.error(message);
            alert(message);
        } else {
            console.log(message);
        }
        return;
    }

    toastEl.textContent = message;
    toastEl.className = 'toast';
    toastEl.classList.add(type, 'show');

    if (toastEl._hideTimeout) {
        clearTimeout(toastEl._hideTimeout);
    }
    toastEl._hideTimeout = setTimeout(() => {
        toastEl.classList.remove('show');
    }, durationMs);
}

function setRecognizing(recognizing) {
    isRecognizing = recognizing;
    if (recognizeBtn) {
        recognizeBtn.classList.toggle('spinning', recognizing);
        recognizeBtn.disabled = recognizing;
    }
}

// Send an image Blob to the CoMER /recognize endpoint and return the LaTeX string.
async function recognizeImage(imageBlob) {
    const formData = new FormData();
    formData.append('file', imageBlob, 'raster.png');

    const response = await fetch(`${COMER_API_URL}/recognize`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Recognition API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    return data;
}

// Main entry: find the active question, detect lines, rasterize each line,
// send to API individually, store per-line results.
async function recognizeActiveQuestion(wb) {
    if (isRecognizing) return;

    const targetQ = findActiveQuestion(wb.answerCapture.questions);
    if (!targetQ) {
        showToast('No active question. Press "b" to add a question first.', 'error');
        return;
    }
    if (!targetQ.bbox) {
        showToast(`Question "${targetQ.id}" has no captured strokes yet. Write your answer first.`, 'error');
        return;
    }

    // Check server health before trying to recognize.
    const serverOnline = await checkComerServer();
    if (!serverOnline) {
        showToast('CoMER server is not running. Start it with: models/start_server.sh', 'error', 6000);
        return;
    }

    // Detect distinct lines of writing within this question
    wb.answerCapture.detectLines(targetQ);
    const lines = targetQ.lines || [];

    if (lines.length === 0) {
        showToast(`No lines detected in question "${targetQ.id}".`, 'error');
        return;
    }

    // Auto-show the line boxes so the user can see the 1.5× threshold result
    if (!wb.answerCapture.showCaptureBoxes) {
        wb.answerCapture.toggleCaptureBoxes();
    } else {
        wb.renderAllStrokes();
    }

    setRecognizing(true);
    showToast(`Recognizing ${lines.length} line(s) in "${targetQ.id}" ...`, 'info', 2000);

    let successCount = 0;
    for (const line of lines) {
        if (!line.bbox) continue;

        const blob = await rasterizeLineToBlob(wb, line);
        if (!blob) continue;

        try {
            const data = await recognizeImage(blob);
            const candidates = data.candidates || [];
            const topLatex = data.top ? data.top.latex : '';

            console.log(`Recognition result for "${line.id}":`, candidates);

            line.recognizedLatex = topLatex;
            line.candidates = candidates;
            successCount++;
        } catch (err) {
            console.error(`Recognition failed for "${line.id}":`, err);
        }
    }

    setRecognizing(false);

    // Synthesize per-line results into a unified LaTeX string
    targetQ.unifiedLatex = synthesizeUnifiedLatex(targetQ);

    // Re-render to show results
    wb.renderAllStrokes();

    if (successCount > 0) {
        const hasUnified = targetQ.unifiedLatex ? ' (unified)' : '';
        showToast(`Recognized ${successCount}/${lines.length} line(s)${hasUnified}.`, 'success', 4000);
    } else {
        showToast('Recognition returned no results.', 'error');
    }
}

// Check if the CoMER API server is reachable (3 second timeout).
async function checkComerServer() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
        const response = await fetch(`${COMER_API_URL}/health`, {
            method: 'GET',
            signal: controller.signal,
        });
        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Render a LaTeX string into an HTML element using KaTeX (if available).
function renderLatex(element, latex) {
    if (typeof katex !== 'undefined') {
        try {
            katex.render(latex, element, {
                throwOnError: false,
                displayMode: false,
            });
            return;
        } catch (err) {
            console.warn('KaTeX render failed, falling back to plain text:', err);
        }
    }
    element.textContent = latex;
}

// Synthesize per-line recognized LaTeX strings into a single unified LaTeX
// string that preserves spatial layout (horizontal indentation, vertical gaps)
// using an `array` environment with \hspace* and \\[Xem] spacing.
// The em scale is based on the median line height so spacing is proportional.
function synthesizeUnifiedLatex(question) {
    if (!question.lines || question.lines.length === 0) return '';

    // Filter to lines that have both a bbox and recognized latex
    const validLines = question.lines.filter(l => l.bbox && l.recognizedLatex);
    if (validLines.length === 0) return '';

    // Find the leftmost line (reference for horizontal offsets)
    let leftmostX = Infinity;
    const lineHeights = [];
    for (const line of validLines) {
        if (line.bbox.x1 < leftmostX) leftmostX = line.bbox.x1;
        lineHeights.push(line.bbox.y2 - line.bbox.y1);
    }

    // Median line height as the em scale factor
    const sortedHeights = [...lineHeights].sort((a, b) => a - b);
    const emScale = sortedHeights[Math.floor(sortedHeights.length / 2)] || 40;

    // Sort lines top-to-bottom
    validLines.sort((a, b) => a.bbox.y1 - b.bbox.y1);

    // Build the LaTeX array
    const rows = [];
    for (let i = 0; i < validLines.length; i++) {
        const line = validLines[i];

        // Horizontal offset from leftmost line, in em units
        const hOffset = (line.bbox.x1 - leftmostX) / emScale;
        const hSpace = hOffset > 0.001 ? `\\hspace*{${hOffset.toFixed(2)}em}` : '';

        // Vertical gap from the previous line's bottom to this line's top
        let vGapStr = '';
        if (i > 0) {
            const prev = validLines[i - 1];
            const vGap = (line.bbox.y1 - prev.bbox.y2) / emScale;
            if (vGap > 0.01) {
                vGapStr = `\\\\[${vGap.toFixed(2)}em]`;
            } else {
                vGapStr = '\\\\';
            }
        }

        const lineLatex = line.recognizedLatex.replace(/\\\\/g, ''); // strip trailing \\ from model output
        if (i === 0) {
            rows.push(`${hSpace}${lineLatex}`);
        } else {
            rows.push(`${vGapStr}\n${hSpace}${lineLatex}`);
        }
    }

    const unifiedLatex = `\\begin{array}{l}\n${rows.join(' ')}\n\\end{array}`;

    console.log(`[synthesizeUnifiedLatex] emScale=${emScale.toFixed(1)}, lines=${validLines.length}, latex:`, unifiedLatex);
    return unifiedLatex;
}
