# LiveCrew Commerce Backend

Simple in-memory FastAPI service for demo commerce state.

Run:

```bash
cd backend
python3 -m pip install -r requirements.txt
python3 -m uvicorn main:app --reload --port 8000
```

Routes:

- `GET /live/state`
- `POST /live/order`
- `POST /live/reset`
- `POST /tools/list_product`
- `POST /tools/change_price`
- `POST /tools/create_flash_sale`
- `POST /tools/update_stock`
- `POST /tools/send_announcement`
