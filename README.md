# Secret Call

This project provides a one-button WebRTC audio call with automatic
localhost.run tunnelling. The codebase is now organised into several
modules to make future extensions easier.

The browser interface lives in `static/index.html` with styles in
`static/style.css`.  Each participant adjusts their own microphone and
playback volume locally in the page; these controls do not affect other
users.

The application icon is provided as `static/icon.svg`.  When building an
executable (e.g. with PyInstaller), supply this icon to give the program a
glassmorphic neon look.

Run the application:

```bash
python main.py
```

