# App Platform Builds

Photon ships from the same React/Tauri codebase to web, desktop, Android, and
iOS. Production app builds point at the hosted sync Worker:

```text
wss://photon-sync.quantum-box.workers.dev/ws
```

## Desktop

Build a local desktop bundle:

```bash
npm run tauri:build
```

Create a GitHub desktop release by pushing a semver tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow builds desktop bundles for macOS, Linux, and Windows and
publishes the GitHub Release when all platform builds finish.

## Android

The Android project lives under `src-tauri/gen/android`.

```bash
npm run tauri:android:dev
npm run tauri:android:build
```

The generated Android manifest includes Internet permission so the bundled app
can connect to the Cloudflare sync Worker.

If `JAVA_HOME` points at an old or missing JDK, use Android Studio's bundled
JBR for the build:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
PATH="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin:$PATH" \
npm run tauri:android:build -- --target aarch64 --apk
```

## iOS

The iOS project lives under `src-tauri/gen/apple`.

```bash
npm run tauri:ios:dev
npm run tauri:ios:build -- --target aarch64-sim
```

Code signing uses the Quantum Box Apple development team configured in
`src-tauri/tauri.conf.json`. Set `APPLE_DEVELOPMENT_TEAM` in CI or the shell to
override it for a different team.

Use the generated Xcode project for device archive and App Store signing:
`src-tauri/gen/apple/photon.xcodeproj`.
