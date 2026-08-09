# We Met v6.1.0 deployment notes

## Deploy

Deploy the complete package. The existing production start command runs the safe database upgrade before starting the server, so the new listener-rate, call-earnings and wallet-ledger fields are created automatically.

## One-time administrator setup

1. Open **Admin → Listener payouts**.
2. Set the agreed rate per connected minute for every existing listener. Existing listeners start at ₹0.00 until an administrator explicitly sets their rate.
3. Add or verify each listener's UPI ID or UPI-linked mobile number.
4. New calls snapshot the current listener rate when ringing begins. Earlier completed calls are retained for analytics but are not credited retroactively.

## Payout workflow

- Every connected call credits the listener wallet once, calculated by connected second and rounded once to the nearest paise.
- **Mark paid** records the exact current balance as a paid withdrawal and brings the current balance to ₹0.00.
- Enter the UPI transaction reference when available. It is stored with the payout history.
- Use **Adjust wallet** only for a documented correction. The server prevents an adjustment from making a wallet negative.
