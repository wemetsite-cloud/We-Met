# We Met v6.5.0

Payment compatibility fix for the verified Paytm Business VPA `paytm.s3hc53w@pty`.

- Official QR identity: `Paytm` / `Verified Paytm Merchant`.
- Generated QR and UPI buttons now share one server-generated URI.
- Selected pack amount is included; We Met checkout reference stays outside the UPI URI for manual admin verification.
- Google Pay on Android is targeted directly with a generic UPI fallback.
- Other UPI apps use the generic `upi://pay` link.
- Existing v6.4 profile photo/avatar features are preserved.

Deploy the complete project so the backend and customer-site payment logic stay in sync.
