# Whiteboard

A browser-based handwriting whiteboard with a CoMER-powered handwriting-to-LaTeX recognizer.

## Run the whiteboard

Open `index.html` in a browser (or serve it with any static file server).

## Run the CoMER recognition server

The whiteboard sends handwritten crops to a local FastAPI server on `http://localhost:8000`.

```bash
cd models
bash start_server.sh
```

The server will load the `model_weights` checkpoint and listen on `http://0.0.0.0:8000`.

## Requirements

- Python 3.9
- The virtual environment in `models/.venv` already contains the required packages (see `models/requirements-api.txt`).

## CoMER model (excluded from this repository)

The handwriting recognizer uses [CoMER](https://github.com/Green-Wood/CoMER) — a Transformer-based encoder-decoder model for online handwritten mathematical expression recognition.

The extracted library directory (`models/CoMER-master/`) and model weights (`models/model_weights`) are excluded from version control due to their size.

To set up CoMER:

```bash
cd models
git clone https://github.com/Green-Wood/CoMER.git CoMER-master
cd CoMER-master
pip install -e .
```

Then download or copy the pretrained checkpoint into `models/model_weights/` and restart the server.

## Using recognition

1. Draw an answer under the question shown on the board.
2. Press the **checkmark** button in the toolbar or press `t`.
3. The recognized LaTeX appears below the question.

If the server is not running, the status dot in the toolbar turns red and a toast message tells you how to start it.
