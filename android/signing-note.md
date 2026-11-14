# Signing

The workflow builds a **debug-signed** APK by default. Android will install it
after the user allows "install unknown apps" for their browser or file manager.

A debug APK is not the same as an untrusted one: it is a real, working build, but
it is signed with a throwaway key that ships with the Android SDK. That has two
consequences worth stating plainly:

- Play Store will not accept it. Play needs a release build signed with your key.
- It cannot be updated in place by a future build signed with a different key; the
  user must uninstall first.

To produce a release-signed APK, add these repository secrets and the workflow
will use them automatically:

| Secret | What it is |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | your .jks file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the key alias inside it |
| `ANDROID_KEY_PASSWORD` | the key password |

Generate one with:

```bash
keytool -genkeypair -v -keystore idol-release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias idol -storetype JKS
base64 -w0 idol-release.jks   # paste into ANDROID_KEYSTORE_BASE64
```

Keep the .jks file. Losing it means you can never update the app under the same
identity again, on any store.
