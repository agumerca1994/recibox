from fastapi import FastAPI
from app.api.routes import router
from app.core.logging import setup_logging

setup_logging()

app = FastAPI(title="RECIBOX Backend", version="0.1.0")
app.include_router(router)

