"""
CoMER Handwriting Recognition API Server

A FastAPI server that loads the CoMER model and exposes a /recognize endpoint.
Accepts a PNG image of handwritten math and returns recognized LaTeX.
"""

import io
import logging
import sys
import time
from pathlib import Path
from typing import Tuple

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from torchvision.transforms import ToTensor

# ── Path setup: add CoMER source to sys.path ──────────────────────────
COMER_DIR = Path(__file__).resolve().parent / "CoMER-master"
sys.path.insert(0, str(COMER_DIR))

from comer.datamodule.vocab import vocab
from comer.lit_comer import LitCoMER
from comer.datamodule.transforms import ScaleToLimitRange

# ── Logging ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────
app = FastAPI(title="CoMER HWR API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model globals ─────────────────────────────────────────────────────
model: LitCoMER = None
device = torch.device("cpu")

scale_transform = ScaleToLimitRange(w_lo=16, w_hi=1024, h_lo=16, h_hi=256)
to_tensor = ToTensor()


# ── Helpers ───────────────────────────────────────────────────────────

def preprocess_image(pil_img: Image.Image) -> Tuple[torch.Tensor, torch.Tensor]:
    """Convert a PIL image to a [1, 1, H, W] tensor and a [1, H, W] mask.

    Steps:
        1. Convert to grayscale
        2. Invert colours: whiteboard is black-on-white, CoMER expects white-on-black
        3. Scale to the size range expected by CoMER (matching CROHME dataset)
        4. Convert to tensor and add a batch dimension
        5. Create a zero mask (all pixels are valid)
    """
    # Grayscale
    if pil_img.mode != "L":
        pil_img = pil_img.convert("L")

    img_np = np.array(pil_img, dtype=np.uint8)

    # Invert colours: the CROHME dataset has white-on-black,
    # but our whiteboard has black-on-white. CoMER was trained on
    # white-on-black (foreground = white pixels), so we invert.
    img_np = 255 - img_np

    # Scale to valid size range
    try:
        img_np = scale_transform(img_np)
    except AssertionError as exc:
        raise ValueError(f"Image dimensions are outside the supported range: {exc}") from exc

    # ToTensor: [0,255] uint8 -> [0,1] float32, shape [1, H, W]
    img_tensor = to_tensor(img_np)

    # Pad to at least 16x16 (CoMER expects minimum size)
    _, h, w = img_tensor.shape
    if h < 16 or w < 16:
        pad_h = max(0, 16 - h)
        pad_w = max(0, 16 - w)
        img_tensor = torch.nn.functional.pad(img_tensor, (0, pad_w, 0, pad_h))
        _, h, w = img_tensor.shape

    # Mask: False = valid pixel, True = padding (none here)
    mask = torch.zeros((h, w), dtype=torch.bool)

    # Add batch dimension
    return img_tensor.unsqueeze(0), mask.unsqueeze(0)


# ── Startup ─────────────────────────────────────────────────────────────

@app.on_event("startup")
def load_model():
    global model

    ckpt_path = Path(__file__).resolve().parent / "model_weights"
    if not ckpt_path.exists():
        raise FileNotFoundError(
            f"Checkpoint not found at {ckpt_path}. "
            "Please ensure models/model_weights exists."
        )

    logger.info(f"Loading checkpoint from {ckpt_path} ...")
    try:
        model = LitCoMER.load_from_checkpoint(
            str(ckpt_path),
            map_location=device,
        )
    except Exception as exc:
        logger.exception("Failed to load model checkpoint")
        raise RuntimeError(f"Failed to load model checkpoint: {exc}") from exc

    model.eval()
    model.to(device)
    logger.info("Model loaded successfully.")


# ── Endpoints ───────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": model is not None}


@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    """Recognize handwritten math from an uploaded PNG image.

    Returns:
        {"latex": "2 x - 5 = 11"}
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Model is not loaded yet.")

    try:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty image file.")

        pil_img = Image.open(io.BytesIO(contents))
    except Exception as exc:
        logger.exception("Failed to read uploaded image")
        raise HTTPException(
            status_code=400,
            detail=f"Could not read image. Ensure a valid PNG/JPEG/BMP/WEBP/GIF is uploaded: {exc}"
        ) from exc

    try:
        img_tensor, mask = preprocess_image(pil_img)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to preprocess image")
        raise HTTPException(status_code=500, detail=f"Preprocessing failed: {exc}") from exc

    img_tensor = img_tensor.to(device)
    mask = mask.to(device)

    start = time.time()
    try:
        with torch.no_grad():
            hyps = model.approximate_joint_search(img_tensor, mask)
    except Exception as exc:
        logger.exception("Model inference failed")
        raise HTTPException(status_code=500, detail=f"Inference failed: {exc}") from exc
    elapsed = time.time() - start

    latex = vocab.indices2label(hyps[0].seq) if hyps else ""
    logger.info(f"Recognized in {elapsed:.2f}s: {latex!r}")

    return {"latex": latex}


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
