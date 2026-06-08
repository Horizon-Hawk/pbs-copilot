"""
Poll Gmail for Venmo payment notifications → issue tokens → email pilot.
Run: python watcher.py
Env: GOOGLE_CREDENTIALS_FILE, GMAIL_TOKEN_FILE, SUPABASE_URL, SUPABASE_KEY,
     ADMIN_EMAIL, VENMO_EXPECTED_AMOUNT (default 30), POLL_INTERVAL_SECONDS (default 60)
"""

import os
import time
import json
import logging
from datetime import datetime, timezone

from email_parser import parse_venmo_email
from token_generator import create_and_send_token
from gmail_auth import get_gmail_service

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL_SECONDS', 60))
EXPECTED_AMOUNT = float(os.environ.get('VENMO_EXPECTED_AMOUNT', 30.0))
SEEN_FILE = os.path.join(os.path.dirname(__file__), '.seen_message_ids.json')


def load_seen():
    try:
        with open(SEEN_FILE) as f:
            return set(json.load(f))
    except FileNotFoundError:
        return set()


def save_seen(seen):
    with open(SEEN_FILE, 'w') as f:
        json.dump(list(seen), f)


def fetch_venmo_emails(service):
    result = service.users().messages().list(
        userId='me',
        q='from:venmo@venmo.com subject:"paid you" is:unread',
        maxResults=10
    ).execute()
    return result.get('messages', [])


def get_message_body(service, msg_id):
    msg = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
    payload = msg.get('payload', {})

    def extract_text(part):
        if part.get('mimeType') == 'text/plain':
            data = part.get('body', {}).get('data', '')
            import base64
            return base64.urlsafe_b64decode(data + '==').decode('utf-8', errors='replace')
        for sub in part.get('parts', []):
            text = extract_text(sub)
            if text:
                return text
        return ''

    return extract_text(payload), msg.get('snippet', '')


def mark_read(service, msg_id):
    service.users().messages().modify(
        userId='me', id=msg_id,
        body={'removeLabelIds': ['UNREAD']}
    ).execute()


def run():
    service = get_gmail_service()
    seen = load_seen()
    log.info('PBS Copilot Gmail watcher started (polling every %ds)', POLL_INTERVAL)

    while True:
        try:
            messages = fetch_venmo_emails(service)
            for m in messages:
                msg_id = m['id']
                if msg_id in seen:
                    continue

                body, snippet = get_message_body(service, msg_id)
                payment = parse_venmo_email(body or snippet)

                if payment is None:
                    log.warning('Could not parse Venmo email %s', msg_id)
                    seen.add(msg_id)
                    save_seen(seen)
                    continue

                if abs(payment['amount'] - EXPECTED_AMOUNT) > 0.01:
                    log.warning(
                        'Wrong amount $%.2f from %s (expected $%.2f)',
                        payment['amount'], payment['sender_email'], EXPECTED_AMOUNT
                    )
                    seen.add(msg_id)
                    save_seen(seen)
                    continue

                log.info('Valid payment $%.2f from %s', payment['amount'], payment['sender_email'])
                create_and_send_token(
                    pilot_email=payment['pilot_email'],
                    sender_name=payment['sender_name'],
                    amount=payment['amount']
                )
                mark_read(service, msg_id)
                seen.add(msg_id)
                save_seen(seen)

        except Exception as e:
            log.error('Poll error: %s', e, exc_info=True)

        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    run()
