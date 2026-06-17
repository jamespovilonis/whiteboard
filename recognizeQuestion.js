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

// Main entry: find the active question, rasterize it, send to API, store result.
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

    setRecognizing(true);
    showToast(`Recognizing question "${targetQ.id}" ...`, 'info', 2000);

    // Rasterize the question's bbox region to a Blob
    const blob = await rasterizeToBlob(wb);
    if (!blob) {
        setRecognizing(false);
        showToast('Failed to rasterize question region.', 'error');
        return;
    }

    try {
        // Send to CoMER API — now returns { candidates: [...], top: {...} }
        const data = await recognizeImage(blob);
        const candidates = data.candidates || [];
        const topLatex = data.top ? data.top.latex : '';

        console.log(`Recognition result for "${targetQ.id}":`, candidates);

        // Store results on the question object
        targetQ.recognizedLatex = topLatex;
        targetQ.candidates = candidates;

        // Re-render the board to show the LaTeX results
        wb.renderAllStrokes();

        if (topLatex) {
            showToast(`Recognized: ${topLatex}`, 'success', 4000);
        } else {
            showToast('Recognition returned empty result.', 'error');
        }
    } catch (err) {
        console.error('Recognition failed:', err);
        showToast(`Recognition failed.\n\n${err.message}`, 'error', 6000);
    } finally {
        setRecognizing(false);
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
