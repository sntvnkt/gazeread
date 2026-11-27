# GazeRead

GazeRead is a Bulgarian-language reading assistant prototype for people with dyslexia. It uses a webcam to estimate which word the reader is looking at and offers help when their gaze lingers: the word is enlarged in place, split into syllables, and optionally spoken aloud.

The project is designed to run in a browser with an ordinary webcam—no dedicated eye-tracking hardware is required. It is an assistive reading tool, not a diagnostic or medical product.

## Features

- **Webcam gaze tracking:** MediaPipe Face Landmarker detects facial and iris landmarks in the browser. A per-user ridge-regression model maps those features to screen coordinates.
- **Optional cloud tracking:** GazeCloudAPI can calibrate and provide gaze coordinates online. It is loaded only when selected; the user must explicitly acknowledge the external camera-data processing before starting it.
- **Calibration and accuracy check:** Full calibration collects gaze samples at 13 screen points. A saved calibration can be checked with six points on later visits.
- **In-place reading support:** A word that holds the reader’s gaze is enlarged without opening an overlay. Press **Shift** if it was read successfully; click it for syllable breakdown and speech.
- **Personal adaptation:** A small online logistic-regression model learns from Shift and help clicks to estimate which words may be difficult and adjust dwell timing. Clicks can also provide additional gaze calibration samples.
- **Accessible reading controls:** Adjustable font, text size, line spacing, voice and speech rate; reading ruler; light/dark theme; optional mouse-based interaction; hard-word list and practice.
- **Flexible input:** Paste or type text, paste formatted article content, or request article text from a URL.
- **Optional accounts:** Save settings, calibration, and personal reading data to an account and use them on another computer. Guest data stays in the browser.

## Run locally

The project has no npm dependencies. It requires Node.js and uses Node’s built-in modules for its small local server.

```sh
node server.js
```

Open [http://localhost:8080](http://localhost:8080). Set `PORT` to use a different port:

```sh
PORT=3000 node server.js
```

Camera access is available on `localhost` or a secure HTTPS origin. Allow camera access when prompted. Chrome or Edge is recommended. The local camera features load MediaPipe and its model from external CDNs, so an internet connection is needed on first use. GazeCloud also requires an internet connection and the page origin must be registered with [GazeRecorder](https://api.gazerecorder.com/register/). Speech voices are provided by the browser and operating system; available languages vary by device.

The reader can also be opened as static files, but account features require `node server.js`.

## Privacy and data

- In local mode, camera frames are processed in the browser and are not uploaded by GazeRead.
- Cloud mode uses GazeRecorder's online GazeCloudAPI. Camera and gaze data are handled by that external provider; review its terms and privacy information before enabling it. The app requires an explicit in-reader acknowledgement before starting cloud tracking.
- Without an account, settings, calibration samples, and reading profile data are kept in browser `localStorage`.
- With an account, profile data is stored in `data/users.json` by the local Node server. Passwords are stored as salted scrypt hashes; session tokens are held in HTTP-only cookies.
- When loading an article by URL, the page address is sent to the configured text-extraction services (Jina Reader, with AllOrigins as a fallback). To avoid sending a URL to those services, copy and paste the article text instead.
- Browser speech synthesis uses the voices available to the browser and device.

This is a small prototype server with a JSON-file data store, intended for local use and experimentation rather than deployment as a public multi-user service.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | Landing page and usage guidance |
| `reader.html` | Reading interface |
| `js/gaze.js` | Webcam tracking, gaze features, calibration, and gaze model |
| `js/reader.js` | Reader UI, word detection, speech, calibration flow, and account UI |
| `js/adapt.js` | Personal word-difficulty model and dwell-time adaptation |
| `js/profile.js` | Browser and account profile persistence |
| `js/syllables.js` | Heuristic Bulgarian and English syllable splitting |
| `server.js` | Static-file server and account/profile API |
| `data/users.json` | Account and profile data store |
| `css/` | Shared styles and color palettes |
| `design-previews/` | Landing-page palette previews |
| `presentation/` | Project presentation and its image assets |
| `prototype-focusread.html` | Earlier, simpler reading-assistant prototype |

Color palettes can be previewed at `design-previews/index.html`. The landing page also accepts `?palette=ocean`, `mint`, `lavender`, `peach`, `night`, or `current`.

## Notes

Gaze estimates from a regular webcam are approximate and can be affected by lighting, camera quality, head movement, and screen setup. The calibration accuracy check and mouse mode provide alternatives when gaze tracking is unreliable. Syllable splitting uses language heuristics and may not be correct for every word.
