# Safari app

`Captode/Captode.xcodeproj` is the Mac app that carries Captode to Safari. It was made with
Xcode's converter from the Safari package:

```
xcrun safari-web-extension-converter dist/captode-1.5.4-safari --project-location safari --app-name Captode --bundle-identifier com.thecodersworld.captode --macos-only --swift --copy-resources --no-open --no-prompt --force
```

then fixed by hand, since the converter got three things wrong:

- the app's bundle ID came out as `com.thecodersworld.Captode`; it must be `com.thecodersworld.captode`,
  the prefix of the extension's `com.thecodersworld.captode.Extension`, or the build fails
- the lowest macOS was set to 27.0; it is 13.0, the oldest that runs Safari 17
- the version was 1.0; it is Captode's version

## A new version

Copy the new package over the extension's files, then set **Version** on both targets:

```
npm run package
rsync -a --delete dist/captode-<version>-safari/ "safari/Captode/Captode Extension/Resources/"
```

## Build without signing

```
xcodebuild -project safari/Captode/Captode.xcodeproj -scheme Captode -derivedDataPath safari/Captode/build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO build
```

An unsigned build shows in Safari only after **Develop → Allow unsigned extensions**. To run
it signed, or to send it to the App Store, see [store/guides/4-safari.md](../store/guides/4-safari.md).
