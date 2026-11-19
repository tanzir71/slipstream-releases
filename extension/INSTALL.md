# Install Slipstream for Chrome as a developer extension

Slipstream for Chrome works in Chrome, Edge, Brave and Arc. Until it's in the browser stores, you install it yourself as an "unpacked" extension. It takes about two minutes.

## 1. Get it
1. Download `slipstream-for-chrome.zip` and `SHA256SUMS` from the latest release: https://github.com/tanzir71/slipstream-releases/releases/latest (or from the Download section of the Slipstream website)
2. Check the download. The command should print `OK` for the zip:
   - macOS: `shasum -a 256 -c SHA256SUMS --ignore-missing`
   - Linux: `sha256sum -c SHA256SUMS --ignore-missing`
   - Windows (PowerShell): `Get-FileHash .\slipstream-for-chrome.zip -Algorithm SHA256`. Compare the hash with the zip's line in `SHA256SUMS`.

## 2. Put it somewhere permanent
Unzip it. You get one folder, `Slipstream for Chrome`, with `manifest.json` and this file inside.

Move that folder somewhere it can stay, for example `~/Applications`, `Documents` or `C:\Tools`, and not `Downloads`. The browser runs the extension from this folder, and your recordings belong to it (see "Updating").

## 3. Install
In each browser, open the extensions page, turn on developer mode, and load the folder:

| Browser | Extensions page | Developer mode switch |
|---|---|---|
| Chrome | `chrome://extensions` | top right |
| Edge | `edge://extensions` | left sidebar ("Developer mode") |
| Brave | `brave://extensions` | top right |
| Arc | `chrome://extensions` (Arc uses Chrome's page) | top right |

1. Type the address into the address bar and press Return.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `Slipstream for Chrome` folder, the one that contains `manifest.json`.
4. Pin it to the toolbar so the button is always there:
   - Chrome, Brave and Arc: click the puzzle-piece icon, then the pin next to Slipstream.
   - Edge: click the puzzle-piece icon, then the eye icon ("Show in toolbar").
5. First run: a welcome tab opens.
   - Allow the camera and microphone. The browser asks once, here, so the recorder can use them later.
   - Choose **Keep recordings in this browser** (the default), or **Share links from my own storage**. The second sets up your own Cloudflare R2, AWS S3, Backblaze B2 or other S3-compatible bucket.

To record, click the Slipstream button or press **Alt+Shift+R**.

## Updating
1. Download and check the new zip as in step 1.
2. Replace the contents of your existing `Slipstream for Chrome` folder with the new files: same folder, same place.
3. On the extensions page, press **Reload** (↻) on Slipstream's card.

Why in place: the browser gives an unpacked extension an ID based on its folder path. Your recordings (kept in the browser's private storage) and your settings, including your storage keys, belong to that ID. If you move or rename the folder, or load a second copy, the browser treats it as a new extension, and it starts empty.

If you need to move it, save what you want to keep first. In the review page, use **Edit in Slipstream** for a `.slipstream` project, or **Download MP4** for the video.

## What the browser may say
These are expected for any extension you load yourself:
- Chrome may show **"Disable developer mode extensions"** when it starts, and the extensions page notes that the extension isn't from the Chrome Web Store. Choose to keep it.
- Edge may ask you to **turn off extensions in developer mode**. Choose to keep it.
- The card shows **Inspect views** and **Errors** links. These are developer tools; you can ignore them.

## Removing
Click **Remove** on Slipstream's card.
- This deletes everything the extension kept in this browser: your recordings, transcripts and settings, including your storage keys.
- It doesn't delete files you already shared to your own bucket. Links keep working until they expire. To remove them, use **Delete from storage** in the library before you remove the extension, or delete the `v/` folder in your bucket.

## Troubleshooting
- **"This tab" won't start recording.** The browser only lets an extension record a tab after you click its toolbar button or press Alt+Shift+R on that tab. Start from the button rather than from the library page.
- **Screen or Window shows black or won't start (macOS).**
  1. Open System Settings → Privacy & Security → Screen & System Audio Recording.
  2. Turn on your browser.
  3. Quit and reopen the browser.
- **The camera or microphone is missing.** Open the welcome page from the library (Settings → Recording → "Open the welcome page") and allow them again. Or allow them in the browser's site settings for the extension.
- **Transcripts and captions.** The speech model ships inside the extension, so there is nothing to download, and nothing leaves your computer. The first transcript after a browser restart takes a little longer while the model loads. This build runs it on your CPU.
- **Links don't work.** Open Settings → Sharing and press Test. The page shows the CORS rule your bucket needs, with a Copy button.
