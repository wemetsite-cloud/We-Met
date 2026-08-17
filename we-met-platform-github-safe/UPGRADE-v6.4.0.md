# We Met v6.4.0

- Payment checkout stays in the normal We Met pink/light theme. The QR image itself remains black on white.
- Listeners can upload a profile photo or choose one of the 20 built-in avatars from Profile.
- Admins can change the same customer-facing listener photo/avatar from Listener > Edit.
- Uploaded photos are cropped and compressed in the browser before storage.
- A new `users.profile_image` column is added automatically by the database schema init.
- Redeploy the backend, customer-site, employee-site and admin-site for this release.
