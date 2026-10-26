Pre-release builds of Inkslide, a pen-first PDF annotator for lecture slides.

| File | System |
|---|---|
| `Inkslide-<version>-x86_64.AppImage` | Linux (any distribution; make it executable and run it) |
| `Inkslide-<version>-x86_64.rpm` | Fedora and other RPM distributions |
| `Inkslide-Setup-<version>.exe` | Windows (installer) |
| `Inkslide-<version>-mac-arm64.dmg` | macOS on Apple silicon |
| `Inkslide-<version>-mac-x64.dmg` | macOS on Intel |

`SHA256SUMS.txt` lists the checksums.

The builds are not code-signed yet:

- **Windows:** SmartScreen warns about an unknown publisher. Choose *More info → Run anyway*.
- **macOS:** the first start is blocked. Right-click the app and choose *Open*, or run
  `xattr -d com.apple.quarantine /Applications/Inkslide.app`.

Linux is the main target and is tested; the Windows and macOS builds are new and have not been
tested much yet. Please report problems in the [issues](https://github.com/ansgomez/inkslide/issues).
