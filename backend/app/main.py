from fastapi import FastAPI
import logging
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import router
from app.core.logging import setup_logging
from app.core.config import settings
from app.services.auth.service_tokens import init_service_tokens_schema
from app.services.templates.store import (
    delete_legacy_templates_by_name,
    init_document_templates_schema,
)
from app.services.templates.classification_rules import init_classification_rules_schema
from app.services.templates.field_transforms import init_template_field_transforms_schema
from app.services.templates.groups import init_template_groups_schema
from app.services.process_runs import init_process_runs_schema
from app.services.reports import init_report_layouts_schema, init_report_runs_schema
from app.services.tenants.user_tenants import init_user_tenants_schema
from app.services.tenants.user_profiles import init_user_profiles_schema

setup_logging()
logger = logging.getLogger(__name__)

app = FastAPI(title="RECIBOX Backend", version="0.1.0")
allowed_origins = [
    origin.strip()
    for origin in settings.cors_allowed_origins.split(",")
    if origin.strip()
]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Cache-Control", "Pragma"],
    )
app.include_router(router)


@app.on_event("startup")
def startup_events():
    if settings.postgres_url:
        init_user_tenants_schema()
        init_user_profiles_schema()
        init_service_tokens_schema()
        init_template_groups_schema()
        init_document_templates_schema()
        init_classification_rules_schema()
        init_template_field_transforms_schema()
        init_process_runs_schema()
        init_report_layouts_schema()
        init_report_runs_schema()
        deleted = delete_legacy_templates_by_name(
            template_names=["Recibo de sueldo mensual"],
        )
        if deleted:
            logger.info("Deleted %s legacy template(s) named 'Recibo de sueldo mensual'", deleted)

