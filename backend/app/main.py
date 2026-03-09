from fastapi import FastAPI
from app.api.routes import router
from app.core.logging import setup_logging
from app.core.config import settings
from app.services.tenants.user_tenants import init_user_tenants_schema
from app.services.tenants.user_profiles import init_user_profiles_schema

setup_logging()

app = FastAPI(title="RECIBOX Backend", version="0.1.0")
app.include_router(router)


@app.on_event("startup")
def startup_events():
    if settings.postgres_url:
        init_user_tenants_schema()
        init_user_profiles_schema()

