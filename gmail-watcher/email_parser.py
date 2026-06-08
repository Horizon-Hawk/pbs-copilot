"""
Parse Venmo payment notification emails.

Venmo sends emails like:
  Subject: <Sender Name> paid you $30.00
  Body contains sender name, amount, and optionally a note.

The pilot must include their email address in the payment note so we know
where to deliver the token. Example note: "PBS bid jeremiapassmore@gmail.com"
"""

import re
from typing import Optional


# Matches "30", "30.00", "$30", "$30.00"
AMOUNT_RE = re.compile(r'\$\s*(\d+(?:\.\d{1,2})?)')

# Matches any email address in the note
EMAIL_RE = re.compile(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+')


def parse_venmo_email(text: str) -> Optional[dict]:
    """
    Returns dict with keys: sender_name, sender_email, pilot_email, amount
    or None if parsing fails.
    """
    if not text:
        return None

    # Extract amount
    amounts = AMOUNT_RE.findall(text)
    if not amounts:
        return None
    amount = float(amounts[0])

    # Extract sender name — Venmo format: "<Name> paid you $X.XX"
    name_match = re.search(r'^(.+?)\s+paid you', text, re.IGNORECASE | re.MULTILINE)
    sender_name = name_match.group(1).strip() if name_match else 'Unknown'

    # Extract emails in the message body
    emails = EMAIL_RE.findall(text)
    # Venmo's own email appears in headers; pilot email should be in the note body
    # Filter out venmo.com addresses
    pilot_emails = [e for e in emails if 'venmo.com' not in e.lower()]

    pilot_email = pilot_emails[0] if pilot_emails else None
    sender_email = next((e for e in emails if 'venmo.com' in e.lower()), None)

    return {
        'sender_name': sender_name,
        'sender_email': sender_email,
        'pilot_email': pilot_email,
        'amount': amount
    }
