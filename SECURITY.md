# Security Policy

## Reporting a vulnerability

Please report security issues privately with GitHub's **Report a vulnerability** button on the [Security tab](https://github.com/DDZ76-Dev/SWTOR-Fob-App/security/advisories/new). Don't open a public issue. You should get a reply within 7 days.

## What the app does with your data

- **Your key stays on your PC.** The security key secret is encrypted with Windows DPAPI (via Electron `safeStorage`) and stored in `%APPDATA%\swtor-security-key\security-key.json`. Only your Windows account can decrypt it.
- **The window never sees the secret.** Codes are generated in the Electron main process. The window runs sandboxed with context isolation and no Node.js access, and can only request the current code and public key details.
- **The key can't be edited.** Once a key is attached, it can only be removed, not changed or read back.
- **No passwords.** The app never asks for your SWTOR or EA password.
- **Minimal network use.** The only network traffic is time checks against public time servers (`time.windows.com`, `time.google.com`, `pool.ntp.org`, falling back to the HTTPS `Date` header from `www.cloudflare.com`). Nothing about you or your key is sent. There is no telemetry, analytics or update check.
- **Careful clipboard use.** The code is copied only when you click the digits. It's cleared when the display turns off, but only if the clipboard still holds that code.
- **Launcher detection only checks process names.** The app runs `tasklist` and checks for `launcher.exe`. It never reads or touches the SWTOR launcher or game.

## Verifying a download

Every release `.exe` is built by GitHub Actions from a tagged commit, with a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations). To verify a download with the GitHub CLI:

```
gh attestation verify "SWTOR Security Key-Setup-<version>.exe" --repo DDZ76-Dev/SWTOR-Fob-App
```

You can also compare its SHA-256 hash with `SHA256SUMS.txt` in the release:

```
certutil -hashfile "SWTOR Security Key-Setup-<version>.exe" SHA256
```
