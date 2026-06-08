"""
Generate a token in Supabase and email it to the pilot.
"""

import os
import secrets
import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from supabase import create_client

log = logging.getLogger(__name__)

supabase = create_client(
    os.environ['SUPABASE_URL'],
    os.environ['SUPABASE_KEY']
)

ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', '')
SMTP_HOST   = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
SMTP_PORT   = int(os.environ.get('SMTP_PORT', 587))
SMTP_USER   = os.environ.get('SMTP_USER', '')
SMTP_PASS   = os.environ.get('SMTP_PASS', '')


def _generate_code() -> str:
    hex4 = secrets.token_hex(2).upper()
    hex4b = secrets.token_hex(2).upper()
    return f'COPILOT-{hex4}-{hex4b}'


def create_token(note: str = '') -> str:
    code = _generate_code()
    supabase.table('tokens').insert({
        'code': code,
        'used': False,
        'note': note
    }).execute()
    return code


def send_token_email(pilot_email: str, sender_name: str, token: str):
    if not pilot_email:
        log.warning('No pilot email — cannot send token')
        return

    subject = 'Your PBS Copilot Submission Token'
    body = f"""Hi {sender_name.split()[0]},

Thanks for your payment! Here is your single-use PBS Copilot token:

    {token}

How to use it:
1. Open NavBlue PBS in Chrome and click the PBS Copilot sidebar icon.
2. Describe your preferences in the "Build with AI" section and click "Build Bid."
3. When you're happy with the preview, enter your token in the "Submission Token" field and click "Submit Bid."

The token works for one submission. If anything goes wrong, reply to this email.

— PBS Copilot
"""

    msg = MIMEMultipart()
    msg['From'] = SMTP_USER
    msg['To'] = pilot_email
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain'))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(SMTP_USER, pilot_email, msg.as_string())

    log.info('Token %s sent to %s', token, pilot_email)


def create_and_send_token(pilot_email: str, sender_name: str, amount: float):
    note = f'${amount:.2f} from {sender_name} ({pilot_email})'
    token = create_token(note=note)
    send_token_email(pilot_email, sender_name, token)
    return token
