# Sorry Fixer

An Android app (Android 8.0 and up) that changes **sorry** into
**Dont say that your good man its ok** in any app, the moment you finish typing
the word.

It catches every spelling of sorry, in any caps:

- `sorry`, `sory`, `soorry`, `sorrrry`, `sorryyyy`
- `sorri`, `sorrie`
- `sowwy`, `sowy`, `sowwie`
- `sry`, `srry`, `sryyy`
- `soz`, `sozz`, `sozzy`, `soza`, `sorz`

It leaves real words like `sorrow`, `sore` and `sowing` alone, and skips password boxes.

## Install it

1. On your phone, open this repo's **Releases** page and download `SorryFixer.apk`
   (it's also attached to every run on the **Actions** tab).
2. Open the file. If Android blocks it, allow your browser or file manager to
   "Install unknown apps" when it asks, then open it again.
3. Open **Sorry Fixer** and tap **Open accessibility settings**.
4. Find **Sorry Fixer** (it may be under "Downloaded services"), switch it on and tap OK.
5. Type `sorry ` anywhere.

To turn it off, switch it off in the same accessibility settings screen.

## How it works

It's an accessibility service, the only way on Android for an app to change what
you type in other apps without replacing your keyboard. When a text box changes,
it checks for a finished "sorry", swaps it out and puts your cursor back where it
was. Android shows a scary warning when you turn on any accessibility service; this
one only reads the text box you're typing in and has no internet permission, so
nothing leaves your phone.

- `app/src/main/java/com/workplease/sorryfix/SorryFixer.java`: the find-and-replace rules
- `app/src/main/java/com/workplease/sorryfix/SorryFixService.java`: the accessibility service
- `app/src/test/...`: tests for the rules

## Build it yourself

With Android Studio or the Android SDK installed: `./gradlew assembleDebug`.
The APK ends up in `app/build/outputs/apk/debug/`.

## No-install alternative

Gboard can do a basic version on its own: **Settings → Dictionary → Personal dictionary**,
add the phrase, and set `sorry` as its shortcut. You then have to tap the
suggestion each time, and it only works in Gboard.
