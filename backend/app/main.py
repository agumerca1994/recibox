from fastapi import FastAPI
import logging
from app.api.routes import router
from app.core.logging import setup_logging
from app.core.config import settings
from app.services.templates.store import (
    delete_legacy_templates_by_name,
    init_document_templates_schema,
)
from app.services.templates.classification_rules import init_classification_rules_schema
from app.services.templates.field_transforms import init_template_field_transforms_schema
from app.services.tenants.user_tenants import init_user_tenants_schema
from app.services.tenants.user_profiles import init_user_profiles_schema

setup_logging()
logger = logging.getLogger(__name__)

app = FastAPI(title="RECIBOX Backend", version="0.1.0")
app.include_router(router)


@app.on_event("startup")
def startup_events():
    if settings.postgres_url:
        init_user_tenants_schema()
        init_user_profiles_schema()
        init_document_templates_schema()
        init_classification_rules_schema()
        init_template_field_transforms_schema()
        deleted = delete_legacy_templates_by_name(
            template_names=["Recibo de sueldo mensual"],
        )
        if deleted:
            logger.info("Deleted %s legacy template(s) named 'Recibo de sueldo mensual'", deleted)

