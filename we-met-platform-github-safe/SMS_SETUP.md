# SMS OTP setup

The server generates each OTP, stores only a hash, limits attempts and expires the challenge. Keep SMS credentials in the deployment environment, never in frontend files or source control.

## Fast2SMS for Indian numbers

1. Complete Fast2SMS KYC and create an approved OTP template.
2. Set `SMS_ENABLED=true`, `SMS_PROVIDER=fast2sms`, `FAST2SMS_API_KEY` and `FAST2SMS_OTP_TEMPLATE_ID`.
3. Keep `SMS_OTP_EXPIRY_MINUTES=10`, save and redeploy.

Fast2SMS is limited to `+91` numbers in this project.

## Twilio for international numbers

1. Configure an SMS-capable sender and complete any required country registration.
2. Set `SMS_ENABLED=true`, `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
3. Set either `TWILIO_FROM_NUMBER` in E.164 format or `TWILIO_MESSAGING_SERVICE_SID`.
4. Save, redeploy and test every supported country.

`SMS_TEST_OTP` works only during local development and is ignored in production.
