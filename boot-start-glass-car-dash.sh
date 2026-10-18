#!/data/data/com.termux/files/usr/bin/bash
# Auto-start the Glass Car Dash backend on boot.
# Requires the Termux:Boot app to actually be present and opened at least
# once — this script alone does nothing without it. install.sh installs and
# launches it automatically via self-ADB; otherwise get it from F-Droid
# (search "Termux:Boot") and open it once yourself.
#
# NOTE: this only auto-starts the Node server. The ADB *connection* itself
# does NOT survive a reboot — adbd resets to default on boot even though
# it was switched to a fixed port via `adb tcpip 5555`. After a reboot:
#   1. Settings > Developer options > Wireless debugging -> ON (re-pair
#      only if it's been forgotten — usually not needed)
#   2. adb tcpip 5555      (re-fix the port; run once, over that connection)
#   3. adb connect 127.0.0.1:5555   (loopback, not the Wi-Fi IP — this is
#      what makes reconnects work with no Wi-Fi/signal at all, e.g. in a
#      car; only step 1-2 above need to happen on a network, and only once
#      per reboot)
# Until reconnected, the backend reports "not connected" but stays up and
# starts working the moment you reconnect — no restart needed.
sleep 5
cd ~/glass-car-dash && ./start.sh --bg
