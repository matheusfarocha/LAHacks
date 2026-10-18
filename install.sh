#!/data/data/com.termux/files/usr/bin/bash
# Glass Car Dash — one-shot Termux installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/drrobotk/glass-car-dash/main/install.sh | bash
#
# Safe to re-run: pulls latest if already installed, never overwrites an
# existing .env, never re-clones over local changes without a plain `git pull`.
set -e

REPO_URL="https://github.com/drrobotk/glass-car-dash.git"
INSTALL_DIR="$HOME/glass-car-dash"

echo "=== Glass Car Dash installer ==="
echo ""

echo "--- packages ---"
pkg update -y
pkg install -y nodejs-lts android-tools git unzip termux-api

echo ""
echo "--- backend code ---"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Existing install found at $INSTALL_DIR — pulling latest"
  cd "$INSTALL_DIR" && git pull
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
chmod +x setup.sh start.sh

echo ""
echo "--- config ---"
if [ ! -f .env ]; then
  cp .env.template .env
  echo ".env created from the template — its default REMOTE_KEY already matches"
  echo "the pre-built .ehpk in this repo's Releases, so the common path (use that"
  echo ".ehpk) needs no changes. Only edit .env if you rebuild your own .ehpk with"
  echo "a different key."
else
  echo ".env already exists, leaving it alone"
fi

echo ""
echo "--- adb / wireless debugging ---"
if adb devices 2>&1 | grep -q "	device$"; then
  echo "Already connected:"
  adb devices -l
else
  echo "Not connected yet. One-time setup on this phone:"
  echo "  1. Settings -> Developer options -> Wireless debugging -> ON"
  echo "  2. Tap 'Pair device with pairing code', note the pairing IP:port + 6-digit code"
  echo "  3. adb pair <pairing-ip>:<pairing-port>   (enter the code when prompted)"
  echo "  4. adb connect <ip>:<port>   (the 'IP address and port' shown on the Wireless debugging screen)"
  echo "  5. adb tcpip 5555            (fixes the port)"
  echo "  6. adb connect 127.0.0.1:5555   (loopback, NOT the IP from step 4 — this is what makes"
  echo "     it work with no Wi-Fi/signal at all, e.g. in a car; the Wi-Fi IP only works on that"
  echo "     one network, which is why an earlier version of this only worked at home)"
  echo "Re-run this installer after connecting, or just run ~/glass-car-dash/start.sh --bg once done."
fi

echo ""
echo "--- boot persistence ---"
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-glass-car-dash.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
sleep 5
cd ~/glass-car-dash && ./start.sh --bg
EOF
chmod +x ~/.termux/boot/start-glass-car-dash.sh
echo "Boot script installed at ~/.termux/boot/start-glass-car-dash.sh."

# The script above only fires on reboot if the separate Termux:Boot app is
# installed AND has been launched at least once (Android's app-hibernation
# blocks a never-opened app's boot receiver). Self-ADB (same trick start.sh's
# media control uses) installs and launches it automatically — no F-Droid
# trip needed — but only once a device is actually connected.
TERMUX_BOOT_PKG="com.termux.boot"
if adb shell pm list packages 2>/dev/null | grep -q "$TERMUX_BOOT_PKG"; then
  echo "Termux:Boot already installed."
elif adb devices 2>&1 | grep -q "	device$"; then
  echo "Installing Termux:Boot via adb (verified release, checksum below)..."
  TB_URL="https://github.com/termux/termux-boot/releases/download/v0.8.1/termux-boot-app_v0.8.1%2Bgithub.debug.apk"
  TB_SHA256="97e6d336f05b59f7cb25e8efa7173e0a6e665f3022b75c6d55a69b6399ecacc8"
  curl -fsSL -o /tmp/termux-boot.apk "$TB_URL"
  if echo "$TB_SHA256  /tmp/termux-boot.apk" | sha256sum -c -; then
    adb install /tmp/termux-boot.apk
    # Launch once so Android's app-hibernation doesn't block its boot receiver.
    adb shell monkey -p "$TERMUX_BOOT_PKG" -c android.intent.category.LAUNCHER 1
    echo "Termux:Boot installed and launched once."
  else
    echo "Checksum mismatch — skipping auto-install. Install Termux:Boot"
    echo "manually from F-Droid (search 'Termux:Boot') and open it once instead."
  fi
  rm -f /tmp/termux-boot.apk
else
  echo "Termux:Boot not installed, and no adb device connected yet to install"
  echo "it automatically. Either re-run this installer after connecting adb"
  echo "(above), or install it manually from F-Droid (search 'Termux:Boot')"
  echo "and open it once."
fi

echo ""
echo "--- starting backend ---"
./start.sh --bg

echo ""
echo "=== Done ==="
echo "Backend running at http://127.0.0.1:8790"
echo "Next: upload the .ehpk (from this repo's Releases, or build your own —"
echo "see README.md) at hub.evenrealities.com, then on your phone:"
echo "Even app -> Developer hub -> unpublished plugins -> Glass Car Dash."
