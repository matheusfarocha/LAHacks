#!/data/data/com.termux/files/usr/bin/bash
# Glass Car Dash backend setup for Termux. Run once.
set -e

echo "=== Glass Car Dash Termux setup ==="

if ! command -v node &>/dev/null; then
  echo "Installing Node.js..."
  pkg update -y && pkg install -y nodejs-lts
else
  echo "Node.js already installed: $(node --version)"
fi

if ! command -v adb &>/dev/null; then
  echo "Installing android-tools (adb)..."
  pkg install -y android-tools
else
  echo "adb already installed"
fi

if [ ! -f ~/glass-car-dash/.env ]; then
  echo ""
  echo "WARNING: ~/glass-car-dash/.env not found!"
  echo "  cp ~/glass-car-dash/.env.template ~/glass-car-dash/.env"
  echo "  nano ~/glass-car-dash/.env     # set REMOTE_KEY to a random string"
else
  echo ".env found"
fi

echo ""
echo "=== Checking adb connection ==="
if adb devices 2>&1 | grep -q "	device$"; then
  echo "A device is connected and authorized:"
  adb devices -l
else
  echo "No authorized device connected yet."
  echo ""
  echo "This device was switched to a FIXED port via 'adb tcpip 5555', so"
  echo "reconnecting is always:"
  echo "    adb connect 127.0.0.1:5555"
  echo "Use 127.0.0.1 (loopback), NOT the phone's Wi-Fi IP — loopback works"
  echo "everywhere (car, no signal, Wi-Fi off entirely) since Termux and adbd"
  echo "are on the same device; the Wi-Fi IP only works on the same network"
  echo "the phone is currently joined to, which breaks the moment you leave"
  echo "it (verified: this was the actual cause of the app not working away"
  echo "from home Wi-Fi — confirmed and fixed 2026-07-05)."
  echo ""
  echo "CAVEAT: 'adb tcpip 5555' does not survive a reboot on an unrooted"
  echo "device — after a reboot, adbd resets and you'll need ONE of:"
  echo "  a) Settings -> Developer options -> Wireless debugging -> ON,"
  echo "     pair again if needed, then re-run: adb tcpip 5555"
  echo "  b) a USB cable + 'adb tcpip 5555' once"
  echo "Once re-run, it's back to the simple 'adb connect 127.0.0.1:5555'"
  echo "above until the next reboot — and that reconnect itself needs no"
  echo "Wi-Fi/signal at all, only the initial re-arm after a reboot does."
fi

echo ""
echo "=== Setup complete ==="
echo "Start the backend:  ~/glass-car-dash/start.sh"
echo "It will listen on http://127.0.0.1:8790"
