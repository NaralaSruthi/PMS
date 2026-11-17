"""One-off manual test: sends a real notification email via SendGrid to
verify the configured API key/sender actually work end-to-end.

Usage: python test_email_send.py recipient@example.com
"""

import sys

from dotenv import load_dotenv

load_dotenv()

import email_service

if len(sys.argv) != 2:
    sys.exit("Usage: python test_email_send.py recipient@example.com")

email_service.send_review_submitted_email(
    to_email=sys.argv[1],
    to_name="Test Recipient",
    employee_name="Test Employee",
    review_period="July 2026 - December 2026",
    template_id=1001,
    submitted_by="Test Employee",
)
print("send attempted — check the inbox and check for any error above")
