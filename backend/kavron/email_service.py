from __future__ import annotations

import smtplib
from email.message import EmailMessage

from .config import settings


def email_configured() -> bool:
    return bool(settings.smtp_host and settings.smtp_from)


def send_email(recipient: str, subject: str, body: str) -> None:
    if not email_configured():
        raise RuntimeError("SMTP email delivery is not configured.")
    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(message)
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            server.starttls()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(message)
