# Slipstream

Free, local-first screen and camera recorder with a reel editor: edit by transcript, remove fillers and pauses,
cinematic zoom, camera layouts, styled captions and 9:16 export. **Nothing you record is ever uploaded.**

- **Website:** https://tanzir71.github.io/slipstream-releases/
- **Slipstream Web** (runs in your browser, nothing to install): https://tanzir71.github.io/slipstream-releases/app/
- **Desktop apps:** [latest release](https://github.com/tanzir71/slipstream-releases/releases/latest)

This repository publishes the website, Slipstream Web and the desktop releases. The desktop apps' source code is
private.

## Install

| Platform | Download |
| --- | --- |
| macOS 26+, Apple silicon | [slipstream-macos.dmg](https://github.com/tanzir71/slipstream-releases/releases/latest/download/slipstream-macos.dmg) |
| Windows 10/11 x64 | [slipstream-windows-x64-setup.exe](https://github.com/tanzir71/slipstream-releases/releases/latest/download/slipstream-windows-x64-setup.exe) ([MSI](https://github.com/tanzir71/slipstream-releases/releases/latest/download/slipstream-windows-x64.msi)) |
| Linux x64 | [AppImage](https://github.com/tanzir71/slipstream-releases/releases/latest/download/slipstream-linux-x64.AppImage) ([DEB](https://github.com/tanzir71/slipstream-releases/releases/latest/download/slipstream-linux-x64.deb)) |

**macOS:** Slipstream isn't notarized (that needs Apple's paid developer program). Installing from Terminal checks the
download's SHA-256 and signature and skips the one-time "Open Anyway" step:

```bash
curl -fsSL https://raw.githubusercontent.com/tanzir71/slipstream-releases/main/install.sh | bash
```

Or open the dmg, drag Slipstream to Applications, open it once, then System Settings → Privacy & Security →
**Open Anyway**.

**Windows:** the installer isn't code-signed yet. If SmartScreen says "Windows protected your PC", choose
**More info → Run anyway**.

## Verify a download

`SHA256SUMS` on each release (and in `download/`) lists every installer:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Privacy

No account, no telemetry, no uploads: see [privacy.html](https://tanzir71.github.io/slipstream-releases/privacy.html).
Third-party components and licences: [third-party.html](https://tanzir71.github.io/slipstream-releases/third-party.html).

## Feedback

Found a bug or want something? [Open an issue](https://github.com/tanzir71/slipstream-releases/issues).
