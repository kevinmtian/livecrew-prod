# LiveCrew Commerce Backend

Simple in-memory FastAPI backend for the hackathon demo.

Run locally:

```bash
python3 -m pip install -r backend/requirements.txt
python3 -m uvicorn backend.main:app --reload --port 8000
```

Required routes:
- `GET /live/state`
- `POST /live/order`
- `POST /live/reset`

Demo tool routes:
- `POST /live/list-product`
- `POST /live/change-price`
- `POST /live/flash-sale`
- `POST /live/stock`
- `POST /live/announcement`
